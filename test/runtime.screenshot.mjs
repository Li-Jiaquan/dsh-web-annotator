#!/usr/bin/env node
/**
 * dsh-web-annotator — page-runtime screenshot capture test (SPEC §10.3 / §10.6)
 *
 * What this covers, in one headless Chrome run against a host-like server:
 *   - lazy load of /vendor/html2canvas.min.js (loaded exactly once for several
 *     capture requests, thanks to the cached promise)
 *   - cross-origin CSS + cross-origin <img> on a second origin: the image is
 *     fetched through the runtime's html2canvas `proxy` (= /asset?url=...), the
 *     CSS is captured via computed styles
 *   - one whole-page render, cropped per annotation rect (+12px padding,
 *     clamped to the page), PNG dataURL, width/height limits
 *   - requestId echo, items order == ids order
 *   - failure paths: unknown id / empty rect / rect outside the page, and
 *     "html2canvas unavailable" (vendor route 404) where every id must fail
 *     without crashing the page
 *   - max 12 images per request, extra ids reported in failed
 *   - options.maxWidth / maxHeight downsampling
 *
 * The in-page harness writes its observations into data-test-* attributes and
 * this script asserts them after `--dump-dom`.
 *
 * No third-party dependencies (Node built-ins only). If no Chrome/Edge is
 * installed: prints an explicit SKIP and exits 0.
 *
 * Usage: node test/runtime.screenshot.mjs
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createAnnotatorServer } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.resolve(HERE, '..', 'runtime.js');
const VENDOR_PATH = path.resolve(HERE, '..', 'vendor', 'html2canvas.min.js');
const PAGE_PATH = path.resolve(HERE, 'runtime.screenshot.html');

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

const failures = [];
let total = 0;

function check(name, ok, detail) {
  total += 1;
  if (ok) {
    console.log(`  PASS  ${name}`);
    return true;
  }
  failures.push(`${name}${detail ? ` (${detail})` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  return false;
}

function attrOf(html, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  return match ? match[1] : null;
}

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

function execFileAsync(file, args, options) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, windowsHide: true, ...options },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
}

async function runHeadless(browser, url, virtualTimeBudget) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'dsha-shot-'));
  try {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--hide-scrollbars',
      `--user-data-dir=${profileDir}`,
      `--virtual-time-budget=${virtualTimeBudget}`,
      '--dump-dom',
      url,
    ];
    return await execFileAsync(browser, args);
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------------------------------------------------------------- *
 * tiny PNG encoder (solid colour) so the cross-origin image needs no asset
 * ---------------------------------------------------------------------- */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function solidPng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------------- *
 * test servers
 * ---------------------------------------------------------------------- */

const RED_PNG = solidPng(200, 100, [255, 0, 0]);
const CROSS_CSS = '.cross-css { background: rgb(0, 128, 255); }';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startCrossOriginServer() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/img.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(RED_PNG);
      return;
    }
    if (url.startsWith('/cross.css')) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(CROSS_CSS);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function startHostLikeServer(originB) {
  const stats = { vendorOkHits: 0, vendorFailHits: 0, assetRequests: [] };
  const state = { vendorMode: 'ok' };

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || '/';
    const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
    try {
      if (requestUrl.pathname === '/page') {
        const template = await readFile(PAGE_PATH, 'utf8');
        let html = template.split('__CROSS_ORIGIN__').join(originB);
        if (requestUrl.searchParams.get('meta') === '1') {
          // v1.5: ready.url must prefer the host-injected target-URL meta.
          html = html.replace(
            '</head>',
            '<meta name="dsh-web-annotator-url" content="https://example.com/final-page" />\n  </head>',
          );
        }
        if (requestUrl.searchParams.get('tall') === '1') {
          // v1.3 limit test: force a page whose long edge is > 2400px.
          html = html.replace(
            '<script src="/runtime.js"></script>',
            '<div style="height:2600px"></div>\n    <script src="/runtime.js"></script>',
          );
        }
        if (requestUrl.searchParams.get('areas') === '1') {
          // The real proxy injects the runtime. Keep an unrelated image well
          // between the selected regions and use a shifted x on the lower one.
          html = html.replace(
            '<script src="/runtime.js"></script>',
            `<div style="height:1300px"></div>
             <div style="height:60px;background-image:url(${originB}/img.png?outside-background)"></div>
             <img src="${originB}/img.png?outside-image" width="200" height="100" />
             <div style="height:1300px"></div>
             <div id="area-end" style="margin-left:360px;width:180px;height:60px;background:rgb(40,120,240)"></div>
             <div style="height:500px"></div>`,
          );
        }
        if (requestUrl.searchParams.get('mirrorbase') === '1') {
          // v1.8: simulate the same-origin mirror document: a /site/ <base>
          // (so anchor.href would be a mirror URL) + the real target URL meta.
          const hostHeader = req.headers.host || '127.0.0.1';
          html = html.replace(
            '</head>',
            '<base href="/site/http/' +
              hostHeader +
              '/" />\n  <meta name="dsh-web-annotator-url" content="https://example.test/base/" />\n  </head>',
          );
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      if (requestUrl.pathname === '/runtime.js') {
        const source = await readFile(RUNTIME_PATH);
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(source);
        return;
      }
      if (requestUrl.pathname === '/vendor/html2canvas.min.js') {
        if (state.vendorMode === 'fail') {
          stats.vendorFailHits += 1;
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('vendor route disabled by test');
          return;
        }
        stats.vendorOkHits += 1;
        const vendor = await readFile(VENDOR_PATH);
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(vendor);
        return;
      }
      if (requestUrl.pathname === '/asset') {
        stats.assetRequests.push(rawUrl);
        // html2canvas appends "url=" itself, so the real request is
        // "?url=&url=<encoded>&responseType=blob"; accept both shapes here
        // (the real host route must tolerate the same thing, see report).
        const candidates = requestUrl.searchParams.getAll('url').filter(Boolean);
        const target = candidates.length > 0 ? candidates[candidates.length - 1] : '';
        let parsed = null;
        try {
          parsed = new URL(target);
        } catch {
          parsed = null;
        }
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== originB) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'invalid asset url' }));
          return;
        }
        const upstream = await fetch(parsed.href, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
        const body = Buffer.from(await upstream.arrayBuffer());
        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        res.writeHead(upstream.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      }
      if (requestUrl.pathname === '/__control/vendor-fail') {
        state.vendorMode = 'fail';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (requestUrl.pathname === '/__control/vendor-ok') {
        state.vendorMode = 'ok';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (requestUrl.pathname === '/__stats') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(stats));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (error) {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`server error: ${(error && error.message) || error}`);
      } catch {
        /* ignore */
      }
    }
  });
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}`, stats, state };
}

/* ====================================================================== *
 * 1. static contract checks
 * ====================================================================== */

console.log('runtime.js — screenshot static contract checks');

let source = '';
try {
  source = await readFile(RUNTIME_PATH, 'utf8');
} catch (error) {
  console.error(`  FAIL  cannot read runtime.js: ${error.message}`);
  process.exit(1);
}

const staticChecks = [
  ['capture-screenshots message type', source.includes("'capture-screenshots'")],
  ['screenshots message type', source.includes("'screenshots'")],
  ['vendor html2canvas path', source.includes("'/vendor/html2canvas.min.js'")],
  ['asset proxy path', source.includes("'/asset?url='")],
  ['requestId echoed', source.includes('requestId: requestId')],
  ['items/failed response shape', source.includes('items: Array.isArray(items)') && source.includes('failed: Array.isArray(failed)')],
  ['lazy-load cached promise', source.includes('h2cPromise')],
  ['legacy modes render one whole-page canvas', source.includes('renderScreenshot(html2canvasFn, docEl, pageWidth, pageHeight, renderScale)')],
  ['useCORS false + allowTaint false', source.includes('useCORS: false') && source.includes('allowTaint: false')],
  ['backgroundColor null', source.includes('backgroundColor: null')],
  ['area render uses offsets and legacy render uses scroll 0', source.includes('x: area ? area.left : 0') && source.includes('scrollX: area ? scrollLeft() : 0')],
  ['crop padding 12px', source.includes('SHOT_PADDING = 12')],
  ['max side 1400', source.includes('SHOT_MAX_SIDE = 1400')],
  ['max 12 images', source.includes('SHOT_MAX_ITEMS = 12')],
  ['single image 1.5MB budget', source.includes('SHOT_MAX_SINGLE_BYTES = 1.5 * 1024 * 1024')],
  ['batch 8MB budget', source.includes('SHOT_MAX_BATCH_BYTES = 8 * 1024 * 1024')],
  ['PNG dataURL output', source.includes("toDataURL('image/png')")],
  ['overlay excluded from the render', source.includes('ignoreElements')],
  ['load failure handled (no throw)', source.includes('html2canvas-load-failed')],
  ['unknown id / empty rect failures', source.includes('unknown-id') && source.includes('empty-rect')],
  ['area mode is supported with full as the legacy fallback', source.includes("options.mode === 'area' || options.mode === 'crop' ? options.mode : 'full'")],
  ['full page uses the fixed id __page__', source.includes("'__page__'")],
  ['full page border colour #e11d48', source.includes("'#e11d48'")],
  ['full page translucent fill', source.includes("'rgba(225,29,72,0.08)'")],
  ['full page badge ~22px', source.includes('FULL_BADGE_SIZE = 22')],
  ['full page long edge <= 2400', source.includes('FULL_MAX_LONG_EDGE = 2400')],
  ['full page PNG <= 3MB', source.includes('FULL_MAX_BYTES = 3 * 1024 * 1024')],
  ['full page 0.85 downscale step, min 800', source.includes('FULL_DOWNSCALE_STEP = 0.85') && source.includes('FULL_MIN_LONG_EDGE = 800')],
  ['v1.7 full page annotated directly on the render canvas (no copy)', source.includes('var ctx = sourceCanvas.getContext') && source.includes('setTransform(1, 0, 0, 1, 0, 0)')],
  ['v1.7 full mode renders at the final long-edge budget', source.includes('fullLongEdge > FULL_MAX_LONG_EDGE') && source.includes('FULL_MAX_LONG_EDGE / fullLongEdge')],
  ['v1.7 render canvas is released after capture', source.includes('function releaseCanvas') && source.includes('releaseCanvas(canvas)')],
  ['crop mode kept as a compatible path', source.includes('cropAnnotation(')],
  ['v1.5 navigate message', source.includes("postTop('navigate'") && source.includes("source === 'window-open'")],
  ['v1.5 target URL meta', source.includes('meta[name="dsh-web-annotator-url"]')],
  ['v1.5 ready carries the target url', source.includes('url: truncate(targetUrlFromDocument()')],
  ['v1.5 link click interception', source.includes('function onDocumentClickCapture') && source.includes('stopImmediatePropagation')],
  ['v1.5 window.open bridge', source.includes('function installWindowOpenBridge') && source.includes('originalOpen.apply')],
  [
    'v1.8 navigate resolves the raw href against the target URL base',
    source.includes('baseUrl = targetUrlFromDocument()') && source.includes("anchor.getAttribute('href')"),
  ],
];

for (const [name, ok] of staticChecks) check(name, ok);

/* ====================================================================== *
 * 2. headless end-to-end checks
 * ====================================================================== */

console.log('\nruntime.screenshot.html — headless cross-origin screenshot e2e');

const browser = findBrowser();
if (!browser) {
  console.log('SKIP: no Chrome/Edge found (looked at CHROME_PATH, DSH_CHROME_PATH and standard install paths).');
  console.log(`static checks: ${total - failures.length}/${total} passed, 0 failed`);
  process.exit(failures.length > 0 ? 1 : 0);
}

console.log(`  browser: ${browser}`);
const cross = await startCrossOriginServer();
const host = await startHostLikeServer(cross.origin);

try {
  /* ---- run 1: full behaviour, cross-origin CSS + image ---- */
  const pageUrl = `${host.origin}/page`;
  console.log(`  page:    ${pageUrl}`);
  console.log(`  cross:   ${cross.origin}`);

  const run1 = await runHeadless(browser, pageUrl, 60000);
  const html1 = run1.stdout || '';
  const status1 = attrOf(html1, 'data-test-status');

  if (!/id="dsh-web-annotator-root"/.test(html1)) {
    console.log('  --- captured stdout (first 2000 chars) ---');
    console.log(html1.slice(0, 2000) || '(empty)');
    if (run1.stderr) console.log(`  --- stderr (first 1200 chars) ---\n${run1.stderr.slice(0, 1200)}`);
    if (run1.error) console.log(`  --- process error: ${run1.error.code || ''} ${run1.error.message || run1.error}`);
  }

  check('dump-dom contains #dsh-web-annotator-root', /id="dsh-web-annotator-root"/.test(html1));
  check('in-page harness completed', status1 !== null, 'no data-test-status attribute');
  check('in-page harness status is pass', status1 === 'pass', status1 === null ? 'missing' : `status=${status1}`);
  if (status1 === 'fail') {
    console.log(`  harness failed step: ${attrOf(html1, 'data-test-failed-step') || '(unknown)'}`);
    const runtimeErrors = attrOf(html1, 'data-test-runtime-errors');
    if (runtimeErrors) console.log(`  runtime errors: ${runtimeErrors}`);
  }

  check('requestId echoed unchanged', attrOf(html1, 'data-test-shot1-request-id-echo') === '1');
  check('items are in ids order', attrOf(html1, 'data-test-shot1-order') === '1');
  check(
    'crop dims = annotation rect + 12px padding (clamped)',
    ['data-test-shot1-green-dims', 'data-test-shot1-img-dims', 'data-test-shot1-crosscss-dims'].every(
      (name) => attrOf(html1, name) === '1',
    ),
  );
  check('element crop has the expected colour', attrOf(html1, 'data-test-shot1-green-color') === '1');
  check('cross-origin <img> captured through /asset proxy', attrOf(html1, 'data-test-shot1-img-color') === '1');
  check('cross-origin CSS captured', attrOf(html1, 'data-test-shot1-crosscss-color') === '1');
  check('all crops are opaque (not blank)', attrOf(html1, 'data-test-shot1-nonblank') === '1');

  check('unknown id / empty rect / off-page rect reported in failed', attrOf(html1, 'data-test-shot2-failed-order') === '1');
  check('failure entries carry a non-empty error', attrOf(html1, 'data-test-shot2-failed-errors') === '1');

  check('at most 12 images per request', attrOf(html1, 'data-test-shot3-max-items') === '1');
  check('ids beyond 12 reported in failed (max-items)', attrOf(html1, 'data-test-shot3-extra-failed') === '1');

  check('options.maxWidth/maxHeight respected', attrOf(html1, 'data-test-shot4-dims') === '1');
  check('aspect ratio kept when downsampling', attrOf(html1, 'data-test-shot4-aspect') === '1');
  check('concurrent capture requests are serialized and both answered', [
    'data-test-shot5-received',
    'data-test-shot5-request-ids',
    'data-test-shot5-items',
  ].every((name) => attrOf(html1, name) === '1'));
  check('empty ids answer with empty items/failed', attrOf(html1, 'data-test-shot6-empty') === '1');

  /* ---- v1.3 full-page annotated screenshot (SPEC §12.2) ---- */
  check(
    'full mode returns a single __page__ PNG',
    ['data-test-full-item-count', 'data-test-full-item-id', 'data-test-full-failed-empty', 'data-test-full-png'].every(
      (name) => attrOf(html1, name) === '1',
    ),
  );
  check('full image matches the page size (no upscale)', attrOf(html1, 'data-test-full-size-page') === '1');
  check('full image long edge <= 2400', attrOf(html1, 'data-test-full-long-edge') === '1');
  check('full image PNG <= 3MB', attrOf(html1, 'data-test-full-bytes-limit') === '1');
  check(
    'full image draws 3px #e11d48 borders on the annotation rects',
    ['data-test-full-border-green', 'data-test-full-border-crosscss'].every((name) => attrOf(html1, name) === '1'),
  );
  check('full image applies the translucent fill', attrOf(html1, 'data-test-full-fill-green') === '1');
  check(
    'full image draws the numbered badge (dark red + white number)',
    ['data-test-full-badge-background', 'data-test-full-badge-number'].every((name) => attrOf(html1, name) === '1'),
  );
  check(
    'full mode: invalid ids go to failed but the page image is still returned',
    ['data-test-full-invalid-page', 'data-test-full-invalid-failed'].every((name) => attrOf(html1, name) === '1'),
  );
  check(
    'full mode: no valid ids -> items=[] (no render)',
    ['data-test-full-none-items', 'data-test-full-none-failed'].every((name) => attrOf(html1, name) === '1'),
  );

  /* ---- v1.5 navigation bridge (SPEC §14.3) ---- */
  check('navigation: test page has the link anchors', attrOf(html1, 'data-test-nav-links-present') === '1');
  check(
    'navigation: relative link -> navigate with the absolute URL',
    attrOf(html1, 'data-test-nav-relative') === '1',
    attrOf(html1, 'data-test-nav-relative-url'),
  );
  check('navigation: relative link default action is prevented', attrOf(html1, 'data-test-nav-relative-default-prevented') === '1');
  check(
    'navigation: link propagation is stopped (stopImmediatePropagation)',
    attrOf(html1, 'data-test-nav-relative-stop-immediate') === '1',
  );
  check('navigation: absolute https link -> navigate', attrOf(html1, 'data-test-nav-external') === '1');
  check('navigation: external link default action is prevented', attrOf(html1, 'data-test-nav-external-default-prevented') === '1');
  check('navigation: pure #hash link is not intercepted', attrOf(html1, 'data-test-nav-hash-ignored') === '1');
  check('navigation: javascript: link is not intercepted', attrOf(html1, 'data-test-nav-javascript-ignored') === '1');
  check(
    'navigation: annotate mode click selects instead of navigating',
    attrOf(html1, 'data-test-nav-annotate-mode') === '1' &&
      attrOf(html1, 'data-test-nav-annotate-select') === '1' &&
      attrOf(html1, 'data-test-nav-annotate-no-navigate') === '1',
  );
  check(
    'navigation: Space-passthrough click navigates',
    attrOf(html1, 'data-test-nav-passthrough') === '1' && attrOf(html1, 'data-test-nav-passthrough-default-prevented') === '1',
  );
  check(
    'navigation: window.open(http(s)) posts navigate and returns null',
    attrOf(html1, 'data-test-nav-window-open') === '1' && attrOf(html1, 'data-test-nav-window-open-null') === '1',
  );
  check('navigation: non-http window.open falls back to the original', attrOf(html1, 'data-test-nav-window-open-fallback') === '1');
  console.log(`    navigate messages: ${attrOf(html1, 'data-test-nav-count')}`);

  check('no page/runtime errors during capture', attrOf(html1, 'data-test-no-errors') === '1');

  console.log('  evidence:');
  console.log(`    page size:        ${attrOf(html1, 'data-test-page-size')}`);
  console.log(`    full image size:  ${attrOf(html1, 'data-test-full-size')}`);
  console.log(`    full image bytes: ${attrOf(html1, 'data-test-full-bytes')}`);
  console.log(`    full badge px:    white=${attrOf(html1, 'data-test-full-badge-white')} darkred=${attrOf(html1, 'data-test-full-badge-red')}`);
  console.log(`    shot1 crop dims:  ${attrOf(html1, 'data-test-shot1-dims')}`);
  console.log(`    shot1 center px:  ${attrOf(html1, 'data-test-shot1-pixels')}`);
  console.log(`    shot2 failed:     ${attrOf(html1, 'data-test-shot2-failed')}`);
  console.log(`    shot3 item count: ${attrOf(html1, 'data-test-shot3-item-count')}`);
  console.log(`    shot4 size:       ${attrOf(html1, 'data-test-shot4-size')}`);

  const stats1 = JSON.parse(await (await fetch(`${host.origin}/__stats`)).text());
  check('html2canvas loaded exactly once for all captures', stats1.vendorOkHits === 1, `hits=${stats1.vendorOkHits}`);
  check('/asset was used for the cross-origin image', stats1.assetRequests.length >= 1, `requests=${stats1.assetRequests.length}`);
  check(
    '/asset requests use the html2canvas proxy convention',
    stats1.assetRequests.every((raw) => raw.includes('responseType=blob') && raw.includes('url=')),
    JSON.stringify(stats1.assetRequests.slice(0, 2)),
  );
  const encodedImage = encodeURIComponent(`${cross.origin}/img.png`);
  check(
    '/asset received the encoded cross-origin image URL',
    stats1.assetRequests.some((raw) => raw.includes(encodedImage)),
    encodedImage,
  );
  console.log(`    /asset raw:       ${stats1.assetRequests[0] || '(none)'}`);

  /* ---- run 1b: v1.3 full mode on a page taller than 2400px (downscale limit) ---- */
  const tallUrl = `${host.origin}/page?tall=1`;
  const runTall = await runHeadless(browser, tallUrl, 90000);
  const htmlTall = runTall.stdout || '';
  const statusTall = attrOf(htmlTall, 'data-test-status');
  check('tall page: harness completed', statusTall !== null, 'no data-test-status attribute');
  check('tall page: harness status is pass', statusTall === 'pass', statusTall === null ? 'missing' : `status=${statusTall}`);
  if (statusTall === 'fail') {
    console.log(`  tall failed step: ${attrOf(htmlTall, 'data-test-failed-step') || '(unknown)'}`);
  }
  check('tall page: single __page__ image', attrOf(htmlTall, 'data-test-tall-single') === '1');
  check('tall page: long edge scaled down to exactly 2400px', attrOf(htmlTall, 'data-test-tall-long-edge') === '1');
  check(
    'tall page: image within 2400px and 3MB',
    ['data-test-tall-within-limit', 'data-test-tall-bytes-limit'].every((name) => attrOf(htmlTall, name) === '1'),
  );
  check('tall page: #e11d48 border survives the downscale', attrOf(htmlTall, 'data-test-tall-border') === '1');
  check('tall page: number badge survives the downscale', attrOf(htmlTall, 'data-test-tall-badge') === '1');
  check('tall page: no page/runtime errors', attrOf(htmlTall, 'data-test-no-errors') === '1');
  console.log(`    tall page size:   ${attrOf(htmlTall, 'data-test-tall-page-size')}`);
  console.log(`    tall full size:   ${attrOf(htmlTall, 'data-test-tall-size')}`);
  console.log(`    tall full bytes:  ${attrOf(htmlTall, 'data-test-tall-bytes')}`);

  // Exercise the same runtime and asset routes used by the app.
  const assetUrls = [];
  const proxy = createAnnotatorServer({ fetchImpl(url, options) {
    const target = new URL(url);
    if (target.origin === cross.origin && target.pathname === '/img.png') assetUrls.push(target);
    return fetch(url, options);
  } });
  try {
    const { origin } = await proxy.start();
    const target = encodeURIComponent(`${host.origin}/page?areas=1`);
    const { stdout: html } = await runHeadless(browser, `${origin}/proxy?url=${target}`, 30000);
    check('area capture: harness status is pass', attrOf(html, 'data-test-status') === 'pass', attrOf(html, 'data-test-failed-step') || 'missing');
    check('area capture: two distant areas with nearby annotations merged into one PNG', attrOf(html, 'data-test-areas-size-ok') === '1');
    check('area capture: correct pixels from both areas while scrolled', attrOf(html, 'data-test-areas-pixels') === '1');
    check('area capture: red outlines and numbered badges on both areas', attrOf(html, 'data-test-areas-marks') === '1');
    check('area capture: excess regions fail independently of the PNG', attrOf(html, 'data-test-areas-cap') === '1');
    check('area capture: in-range image uses the host asset proxy', assetUrls.some((url) => url.search === ''));
    check('area capture: out-of-range images skip the host asset proxy', assetUrls.every((url) => url.search === ''));
    console.log(`    area image:       ${attrOf(html, 'data-test-areas-size')}`);
  } finally {
    await proxy.close();
  }

  /* ---- run 1c: v1.5 ready.url prefers the host-injected meta ---- */
  const runMeta = await runHeadless(browser, `${host.origin}/page?meta=1`, 30000);
  const htmlMeta = runMeta.stdout || '';
  check(
    'ready url: meta page harness status is pass',
    attrOf(htmlMeta, 'data-test-status') === 'pass',
    attrOf(htmlMeta, 'data-test-status') || 'missing',
  );
  check(
    'ready url: prefers <meta name="dsh-web-annotator-url">',
    attrOf(htmlMeta, 'data-test-ready-url-meta') === '1',
    attrOf(htmlMeta, 'data-test-ready-url-value'),
  );
  console.log(`    ready url (meta):   ${attrOf(htmlMeta, 'data-test-ready-url-value')}`);

  /* ---- run 1d: v1.5 ready.url falls back to the proxy ?url= parameter ---- */
  const readyQueryTarget = 'https://example.com/from-query';
  const readyQueryUrl = `${host.origin}/page?readyquery=1&url=${encodeURIComponent(readyQueryTarget)}`;
  const runQuery = await runHeadless(browser, readyQueryUrl, 30000);
  const htmlQuery = runQuery.stdout || '';
  check(
    'ready url: query page harness status is pass',
    attrOf(htmlQuery, 'data-test-status') === 'pass',
    attrOf(htmlQuery, 'data-test-status') || 'missing',
  );
  check(
    'ready url: falls back to the decoded ?url= parameter',
    attrOf(htmlQuery, 'data-test-ready-url-query') === '1',
    attrOf(htmlQuery, 'data-test-ready-url-value'),
  );
  console.log(`    ready url (query):  ${attrOf(htmlQuery, 'data-test-ready-url-value')}`);

  /* ---- run 1e: v1.8 mirror <base> must not leak into navigate URLs ---- */
  const mirrorBaseUrl = `${host.origin}/page?mirrorbase=1`;
  const runMirror = await runHeadless(browser, mirrorBaseUrl, 30000);
  const htmlMirror = runMirror.stdout || '';
  const statusMirror = attrOf(htmlMirror, 'data-test-status');
  check('mirror base: harness completed', statusMirror !== null, 'no data-test-status attribute');
  check('mirror base: harness status is pass', statusMirror === 'pass', statusMirror === null ? 'missing' : `status=${statusMirror}`);
  if (statusMirror === 'fail') {
    console.log(`  mirror base failed step: ${attrOf(htmlMirror, 'data-test-failed-step') || '(unknown)'}`);
  }
  check('mirror base: fixture anchor.href is a /site/ mirror URL', attrOf(htmlMirror, 'data-test-mirror-base-installed') === '1', attrOf(htmlMirror, 'data-test-mirror-anchor-href'));
  check('mirror base: ready.url still the target URL from meta', attrOf(htmlMirror, 'data-test-mirror-ready-url-meta') === '1', attrOf(htmlMirror, 'data-test-mirror-ready-url'));
  check(
    'mirror base: href="next" navigates to the target URL, not the mirror URL',
    attrOf(htmlMirror, 'data-test-mirror-relative') === '1' &&
      attrOf(htmlMirror, 'data-test-mirror-relative-default-prevented') === '1',
    attrOf(htmlMirror, 'data-test-mirror-relative-url'),
  );
  check(
    'mirror base: href="/x" navigates to the target origin root',
    attrOf(htmlMirror, 'data-test-mirror-root-relative') === '1',
    attrOf(htmlMirror, 'data-test-mirror-root-url'),
  );
  check('mirror base: absolute https link unchanged', attrOf(htmlMirror, 'data-test-mirror-absolute') === '1');
  check('mirror base: javascript: link still ignored', attrOf(htmlMirror, 'data-test-mirror-javascript-ignored') === '1');
  check(
    'mirror base: window.open(relative) resolves against the target URL',
    attrOf(htmlMirror, 'data-test-mirror-window-open') === '1' && attrOf(htmlMirror, 'data-test-mirror-window-open-null') === '1',
    attrOf(htmlMirror, 'data-test-mirror-window-open-url'),
  );
  check('mirror base: window.open(absolute https) unchanged', attrOf(htmlMirror, 'data-test-mirror-window-open-absolute') === '1');
  check('mirror base: no page/runtime errors', attrOf(htmlMirror, 'data-test-no-errors') === '1');
  console.log(`    mirror anchor.href: ${attrOf(htmlMirror, 'data-test-mirror-anchor-href')}`);
  console.log(`    mirror navigate url: ${attrOf(htmlMirror, 'data-test-mirror-relative-url')}`);
  console.log(`    mirror root-relative: ${attrOf(htmlMirror, 'data-test-mirror-root-url')}`);
  console.log(`    mirror window.open:  ${attrOf(htmlMirror, 'data-test-mirror-window-open-url')}`);

  /* ---- run 2: html2canvas unavailable (vendor 404) ---- */
  await fetch(`${host.origin}/__control/vendor-fail`);
  const run2 = await runHeadless(browser, `${host.origin}/page?novendor=1`, 30000);
  const html2 = run2.stdout || '';
  const status2 = attrOf(html2, 'data-test-status');

  check('no-vendor: overlay root still present (page did not crash)', /id="dsh-web-annotator-root"/.test(html2));
  check('no-vendor: harness completed', status2 !== null, 'no data-test-status attribute');
  check('no-vendor: harness status is pass', status2 === 'pass', status2 === null ? 'missing' : `status=${status2}`);
  if (status2 === 'fail') {
    console.log(`  no-vendor failed step: ${attrOf(html2, 'data-test-failed-step') || '(unknown)'}`);
  }
  check('no-vendor: every id reported in failed', attrOf(html2, 'data-test-novendor-all-failed') === '1');
  check('no-vendor: error code is html2canvas-load-failed', attrOf(html2, 'data-test-novendor-error-code') === '1');
  check('no-vendor: page reported no uncaught errors', attrOf(html2, 'data-test-novendor-no-errors') === '1');

  const stats2 = JSON.parse(await (await fetch(`${host.origin}/__stats`)).text());
  check('no-vendor: vendor 404 was actually served', stats2.vendorFailHits === 1, `hits=${stats2.vendorFailHits}`);
} finally {
  await new Promise((resolve) => host.server.close(resolve));
  await new Promise((resolve) => cross.server.close(resolve));
}

/* ====================================================================== *
 * summary
 * ====================================================================== */

console.log('');
console.log(`checks: ${total - failures.length}/${total} passed`);
if (failures.length > 0) {
  console.log(`FAILED (${failures.length}):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('OK: runtime.js screenshot capture verified (cross-origin CSS + image, crop, limits, failure paths).');
process.exit(0);
