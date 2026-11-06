#!/usr/bin/env node
/**
 * dsh-web-annotator — capture benchmark for clustered annotations on a long page.
 *
 * Serves a deterministic fixture (40 rows ≈ 5560px tall, gradient background,
 * 40 local images, no network) through a host-like local server, drives the
 * runtime's `capture-screenshots` in `full` or `area` mode three times through headless
 * Chrome (CDP, real time — no virtual-time clock), and prints:
 *   - capture_ms (median of 3; wall time from request to `screenshots` message)
 *   - render canvas pixels/size/scale (html2canvas output)
 *   - output image size + PNG bytes
 *   - peak single-canvas area / number of >=1MP canvases created
 *
 * A/B two runtime builds on the same fixture/machine:
 *   node test/bench.capture.mjs --label baseline --runtime path/to/runtime.js
 *   node test/bench.capture.mjs --label optimized
 *   node test/bench.capture.mjs --mode area --annotations 3
 *
 * No third-party dependencies (Node 22+ global WebSocket for CDP).
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.resolve(HERE, '..', 'runtime.js');
const PAGE_PATH = path.resolve(HERE, 'bench.page.html');
const VENDOR_PATH = path.resolve(HERE, '..', 'vendor', 'html2canvas.min.js');

const BROWSER_CANDIDATES = [
  process.env.DSH_CHROME_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* ---------------------------------------------------------------- PNG fixture */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function makePng(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------- CDP glue */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }

  send(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`cannot connect to ${wsUrl}`));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevtoolsPort(profileDir, timeoutMs) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      const port = Number(lines[0]);
      if (port > 0 && lines[1]) return { port, browserWsPath: lines[1].trim() };
    } catch {
      /* not written yet */
    }
    await sleep(100);
  }
  throw new Error('timed out waiting for DevToolsActivePort');
}

async function stopChrome(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* best effort */
  }
}

/* --------------------------------------------------------------------- main */

const labelArgIndex = process.argv.indexOf('--label');
const label = labelArgIndex >= 0 ? String(process.argv[labelArgIndex + 1] || 'run') : 'run';

// Optional runtime override so the same fixture can A/B two runtime builds.
const runtimeArgIndex = process.argv.indexOf('--runtime');
const runtimePath = runtimeArgIndex >= 0 ? path.resolve(process.argv[runtimeArgIndex + 1]) : RUNTIME_PATH;
const modeArgIndex = process.argv.indexOf('--mode');
const mode = modeArgIndex >= 0 ? process.argv[modeArgIndex + 1] : 'full';
const countArgIndex = process.argv.indexOf('--annotations');
const annotationCount = countArgIndex >= 0 ? Number(process.argv[countArgIndex + 1]) : 12;
if (!['full', 'area'].includes(mode) || !Number.isInteger(annotationCount) || annotationCount < 1 || annotationCount > 12) {
  throw new Error('Expected --mode full|area and --annotations 1..12');
}

const browser = findBrowser();
if (!browser) {
  console.log('SKIP: no Chrome/Edge found (looked at CHROME_PATH, DSH_CHROME_PATH and standard install paths).');
  process.exit(0);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (requestUrl.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await readFile(PAGE_PATH, 'utf8'));
      return;
    }
    if (requestUrl.pathname === '/runtime.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await readFile(runtimePath));
      return;
    }
    if (requestUrl.pathname === '/vendor/html2canvas.min.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await readFile(VENDOR_PATH));
      return;
    }
    if (requestUrl.pathname.startsWith('/img/')) {
      const match = /^\/img\/(\d+)\.png$/.exec(requestUrl.pathname);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const index = Number(match[1]);
      const png = makePng(64, 32, [(index * 37) % 256, (index * 91) % 256, (index * 53) % 256]);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(png);
      return;
    }
    if (requestUrl.pathname === '/asset') {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'bench fixture has no cross-origin assets' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String((error && error.message) || error));
  }
});

const origin = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const profileDir = await mkdtemp(path.join(os.tmpdir(), 'dsha-bench-'));
let chrome = null;
let browserWs = null;
let pageWs = null;
let benchResult = null;

try {
  const pageUrl = `${origin}/page?mode=${mode}&annotations=${annotationCount}`;
  console.log(`bench page: ${pageUrl}`);
  console.log(`runtime:    ${runtimePath}`);
  console.log(`label:      ${label}`);

  chrome = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--window-size=800,600',
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  const devtools = await waitForDevtoolsPort(profileDir, 20000);
  const devtoolsBase = `http://127.0.0.1:${devtools.port}`;

  browserWs = await connectWebSocket(`ws://127.0.0.1:${devtools.port}${devtools.browserWsPath}`);
  const browserCdp = new Cdp(browserWs);
  const created = await browserCdp.send('Target.createTarget', { url: pageUrl });

  // Find the page target's own WebSocket endpoint.
  let pageEntry = null;
  const deadline = Date.now() + 15000;
  while (!pageEntry && Date.now() < deadline) {
    const list = await (await fetch(`${devtoolsBase}/json/list`)).json();
    pageEntry = list.find((entry) => entry.type === 'page' && entry.id === created.targetId) || null;
    if (!pageEntry) pageEntry = list.find((entry) => entry.type === 'page' && entry.url.startsWith(origin)) || null;
    if (!pageEntry) await sleep(100);
  }
  if (!pageEntry) throw new Error('page target not found');

  pageWs = await connectWebSocket(pageEntry.webSocketDebuggerUrl);
  const pageCdp = new Cdp(pageWs);
  await pageCdp.send('Runtime.enable');

  // Wait until the page finished loading and the bench harness is installed.
  const readyDeadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const probe = await pageCdp.send('Runtime.evaluate', {
      expression: 'typeof window.__benchRun === "function" && document.readyState === "complete" && !!document.getElementById("dsh-web-annotator-root")',
      returnByValue: true,
    });
    if (probe && probe.result && probe.result.value === true) {
      ready = true;
      break;
    }
    await sleep(100);
  }
  if (!ready) throw new Error('bench harness did not become ready');

  const evaluated = await pageCdp.send('Runtime.evaluate', {
    expression: 'window.__benchRun()',
    awaitPromise: true,
    returnByValue: true,
  });
  benchResult = evaluated && evaluated.result ? evaluated.result.value : null;
  if (!benchResult) throw new Error('bench run returned no result');
} catch (error) {
  console.error(`bench failed: ${(error && error.message) || String(error)}`);
} finally {
  try {
    if (pageWs) pageWs.close();
  } catch {
    /* ignore */
  }
  try {
    if (browserWs) browserWs.close();
  } catch {
    /* ignore */
  }
  await stopChrome(chrome);
  await new Promise((resolve) => server.close(resolve));
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

if (!benchResult) {
  process.exit(1);
}

if (benchResult.status === 'fail') {
  console.log(`BENCH FAILED: ${benchResult.error || 'unknown error'}`);
  console.log(`BENCH_JSON: ${JSON.stringify({ label, status: 'fail', error: benchResult.error || 'unknown' })}`);
  process.exit(1);
}

const captures = Array.isArray(benchResult.captures) ? benchResult.captures : [];
const captureTimes = captures.map((entry) => entry.captureMs).sort((a, b) => a - b);
const medianCaptureMs = captureTimes.length > 0 ? captureTimes[Math.floor(captureTimes.length / 2)] : 0;
const medianRenderMs = (() => {
  const values = captures.map((entry) => entry.renderMs).sort((a, b) => a - b);
  return values.length > 0 ? values[Math.floor(values.length / 2)] : 0;
})();
const canvas = captures.length > 0 && captures[0].canvas ? captures[0].canvas : null;
const output = captures.length > 0 ? captures[0].output : null;
const bytes = captures.length > 0 ? captures[0].bytes : 0;
const pageSize = benchResult.pageSize || null;

const summary = {
  label,
  mode,
  annotationCount,
  status: 'ok',
  page: pageSize ? `${pageSize.width}x${pageSize.height}` : 'unknown',
  pagePixels: pageSize ? pageSize.width * pageSize.height : 0,
  captures: captureTimes,
  capture_ms_median: medianCaptureMs,
  render_ms_median: medianRenderMs,
  render_canvas: canvas,
  render_canvas_pixels: canvas ? canvas.pixels : 0,
  output: output ? `${output.width}x${output.height}` : 'none',
  output_bytes: bytes,
  peak_single_canvas_pixels: benchResult.maxCanvasPixels || 0,
  big_canvas_count: benchResult.bigCanvasCount || 0,
  created_canvas_count: benchResult.createdCanvasCount || 0,
};

console.log('');
console.log(`BENCH label=${summary.label} mode=${mode} annotations=${annotationCount} page=${summary.page}`);
console.log(`  capture_ms (3):     ${captureTimes.join(', ')}  -> median ${summary.capture_ms_median} ms`);
console.log(`  html2canvas ms (3): ${captures.map((entry) => entry.renderMs).join(', ')}  -> median ${summary.render_ms_median} ms`);
if (canvas) {
  console.log(`  render canvas:      ${canvas.width}x${canvas.height} = ${canvas.pixels} px (scale=${canvas.scale})`);
}
console.log(`  output image:       ${summary.output}, ${summary.output_bytes} bytes`);
console.log(`  peak single canvas: ${summary.peak_single_canvas_pixels} px; canvases >=1MP created: ${summary.big_canvas_count}; total canvases: ${summary.created_canvas_count}`);
console.log(`BENCH_JSON: ${JSON.stringify(summary)}`);
