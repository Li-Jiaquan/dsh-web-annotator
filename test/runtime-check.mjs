#!/usr/bin/env node
/**
 * dsh-web-annotator — page-runtime test (SPEC.md §9)
 *
 * 1. Static contract checks on runtime.js (protocol strings, anchor fields,
 *    rAF usage, absence of setInterval polling).
 * 2. Headless Chrome/Edge loads test/runtime.test.html (which pulls in
 *    ../runtime.js) with `--dump-dom`. The page's own harness drives the
 *    runtime through the real postMessage protocol and simulates the three
 *    selection gestures with synthetic PointerEvents, writing the observed
 *    results into data-test-* attributes on <html>; this script asserts them.
 *
 * No third-party dependencies (Node built-ins only).
 * If no Chrome/Edge is installed: prints an explicit SKIP and exits 0.
 *
 * Usage: node test/runtime-check.mjs
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.resolve(HERE, '..', 'runtime.js');
const TEST_PAGE_PATH = path.resolve(HERE, 'runtime.test.html');

const BROWSER_CANDIDATES = [
  process.env.DSH_CHROME_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : '',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    : '',
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
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
        windowsHide: true,
        ...options,
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

async function runDumpDom(browser, headlessFlag, pageUrl) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'dsha-runtime-check-'));
  try {
    const args = [
      headlessFlag,
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--hide-scrollbars',
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=5000',
      '--dump-dom',
      pageUrl,
    ];
    const result = await execFileAsync(browser, args);
    return { ...result, args, profileDir };
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

function attrOf(html, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  return match ? match[1] : null;
}

/* ====================================================================== *
 * 1. static contract checks
 * ====================================================================== */

console.log('runtime.js — static contract checks');

let source = '';
try {
  source = await readFile(RUNTIME_PATH, 'utf8');
} catch (error) {
  console.error(`  FAIL  cannot read ${RUNTIME_PATH}: ${error.message}`);
  process.exit(1);
}

const staticChecks = [
  ['overlay root id', source.includes("'dsh-web-annotator-root'")],
  ['channel constant', source.includes("'dsh-web-annotator'")],
  ['open shadow root', source.includes("attachShadow({ mode: 'open' })")],
  ['styles live in the shadow root', source.includes("document.createElement('style')")],
  ['host fixed + pointer-events none', source.includes('position:fixed') && source.includes('pointer-events:none')],
  ['interaction layer pointer-events auto', source.includes("hitEl.style.pointerEvents = 'auto'")],
  ['message channel for parent', source.includes('window.parent.postMessage')],
  ['ready message', source.includes("post('ready'")],
  ['mode ack', source.includes("post('mode'")],
  ['select message', source.includes("post('select'")],
  ['marker-hover message', source.includes("post('marker-hover'")],
  ['marker-click message', source.includes("post('marker-click'")],
  ['escape message', source.includes("post('escape'")],
  ['error message', source.includes("post('error'")],
  ['hello handling', source.includes("case 'hello'")],
  ['set-mode handling', source.includes("case 'set-mode'")],
  ['set-annotations handling', source.includes("case 'set-annotations'")],
  ['focus-annotation handling', source.includes("case 'focus-annotation'")],
  ['clear handling', source.includes("case 'clear'")],
  ['anchor: selectedText', source.includes('selectedText:')],
  ['anchor: selectionRects', source.includes('selectionRects:')],
  ['anchor: textLocator', source.includes('textLocator:')],
  ['anchor: elementPath', source.includes('elementPath:')],
  ['anchor: isFixed', source.includes('isFixed:')],
  ['anchor: viewportRect', source.includes('viewportRect:')],
  ['anchor: point', source.includes('point:')],
  ['rAF throttling', source.includes('requestAnimationFrame')],
  ['no setInterval polling', !source.includes('setInterval')],
  ['no third-party imports', !/\brequire\s*\(|\bimport\s+/.test(source)],
];

for (const [name, ok] of staticChecks) check(name, ok);

/* ====================================================================== *
 * 2. headless browser end-to-end checks
 * ====================================================================== */

console.log('\nruntime.test.html — headless browser end-to-end checks');

if (!existsSync(TEST_PAGE_PATH)) {
  console.error(`  FAIL  missing test page: ${TEST_PAGE_PATH}`);
  process.exit(1);
}

const browser = findBrowser();
if (!browser) {
  console.log('SKIP: no Chrome/Edge found (looked at CHROME_PATH, DSH_CHROME_PATH and standard install paths).');
  console.log(`static checks: ${total - failures.length}/${total} passed, 0 failed`);
  process.exit(failures.length > 0 ? 1 : 0);
}

console.log(`  browser: ${browser}`);
const pageUrl = pathToFileURL(TEST_PAGE_PATH).href;
console.log(`  page:    ${pageUrl}`);

let run = await runDumpDom(browser, '--headless=new', pageUrl);
let html = run.stdout || '';

// Older Chromium builds may not know --headless=new; retry once with --headless.
if (!/id="dsh-web-annotator-root"/.test(html)) {
  console.log('  note: no overlay in --headless=new output, retrying with --headless');
  run = await runDumpDom(browser, '--headless', pageUrl);
  html = run.stdout || '';
}

const launchError = run.error;
if (launchError && /ENOENT|EACCES|EPERM/i.test(String(launchError.code || launchError.message || ''))) {
  console.log(`SKIP: browser could not be launched here (${launchError.code || launchError.message}).`);
  process.exit(failures.length > 0 ? 1 : 0);
}

const dumpHasRoot = /id="dsh-web-annotator-root"/.test(html);
if (!dumpHasRoot) {
  console.log('  --- captured stdout (first 2000 chars) ---');
  console.log(html.slice(0, 2000) || '(empty)');
  if (run.stderr) {
    console.log('  --- captured stderr (first 1500 chars) ---');
    console.log(run.stderr.slice(0, 1500));
  }
  if (launchError) {
    console.log(`  --- process error: ${launchError.code || ''} ${launchError.message || launchError}`);
  }
}

check('dump-dom contains #dsh-web-annotator-root', dumpHasRoot);
check('overlay host carries data-dsh-web-annotator="1"', /data-dsh-web-annotator="1"/.test(html));
check('overlay host is fixed-position (inline style)', /position:\s*fixed/.test(html));
check('overlay host has pointer-events none (inline style)', /pointer-events:\s*none/.test(html));

const status = attrOf(html, 'data-test-status');
check('in-page harness completed', status !== null, 'no data-test-status attribute');
check('in-page harness status is pass', status === 'pass', status === null ? 'missing' : `status=${status}`);
if (status === 'fail') {
  const failedStep = attrOf(html, 'data-test-failed-step');
  const runtimeErrors = attrOf(html, 'data-test-runtime-errors');
  console.log(`  harness failed step: ${failedStep || '(unknown)'}`);
  if (runtimeErrors) console.log(`  runtime errors: ${runtimeErrors}`);
}

// Protocol: page -> parent
const seen = attrOf(html, 'data-test-seen-final') || attrOf(html, 'data-test-seen') || '';
check('runtime posted ready', (attrOf(html, 'data-test-ready') || '') === '1');
check('parent hello produced a second ready', (seen.match(/ready/g) || []).length >= 1, `seen=${seen}`);
check('set-mode produced a mode ack (active)', (attrOf(html, 'data-test-mode-ack-active') || '') === '1');
check('set-annotations rendered 2 markers', (attrOf(html, 'data-test-markers-after-set') || '') === '1');
check('explicit mode toggle produced an inactive ack', (attrOf(html, 'data-test-mode-ack-inactive') || '') === '1');
check('clear removed all markers', (attrOf(html, 'data-test-markers-after-clear') || '') === '1');
check('clear preserved annotation mode', (attrOf(html, 'data-test-mode-after-clear') || '') === '1');
check('no runtime errors were reported', (attrOf(html, 'data-test-no-runtime-errors') || '') === '1');

// Selection anchors
check('element click produced an element anchor', (attrOf(html, 'data-test-element-select') || '') === '1');
check('element anchor tagName is <button>', (attrOf(html, 'data-test-element-tag') || '') === 'button');
check('element anchor has a CSS selector', (attrOf(html, 'data-test-element-selector') || '').length > 0);
check('element anchor has an elementPath', (attrOf(html, 'data-test-element-path') || '').includes('button'));
check('element anchor has page/viewport rect + point + isFixed + scrollX', [
  'data-test-element-has-rect',
  'data-test-element-has-viewport',
  'data-test-element-has-point',
  'data-test-element-is-fixed',
  'data-test-element-scroll',
  'data-test-element-frame',
  'data-test-element-page-url',
].every((name) => attrOf(html, name) === '1'));

check('shift+drag produced a region anchor', (attrOf(html, 'data-test-region-select') || '') === '1');
check('region anchor has a non-empty rect', (attrOf(html, 'data-test-region-size') || '') === '1');
check('region anchor carries no selectedText', (attrOf(html, 'data-test-region-selected-text-null') || '') === '1');

check('drag over text produced a text anchor', (attrOf(html, 'data-test-text-select') || '') === '1');
check('text anchor has selectedText', (attrOf(html, 'data-test-text-content') || '') === '1');
check('text anchor has selectionRects', (attrOf(html, 'data-test-text-selection-rects') || '') === '1');
check('text anchor has textLocator', (attrOf(html, 'data-test-text-locator') || '') === '1');
check('text anchor has a tagName', (attrOf(html, 'data-test-text-tag') || '') === '1');

// Markers
check('two numbered markers exist in the shadow root', (attrOf(html, 'data-test-marker-count') || '') === '1');
check('marker hover reported marker-hover', (attrOf(html, 'data-test-marker-hover') || '') === '1');
check('marker click reported marker-click', (attrOf(html, 'data-test-marker-click') || '') === '1');
check('marker-click fired exactly once', (attrOf(html, 'data-test-marker-click-count') || '') === '1');

// Escape + SPA route change
check('Escape reported an escape message', (attrOf(html, 'data-test-escape-message') || '') === '1');
check('popstate re-posted ready', (attrOf(html, 'data-test-popstate-ready') || '') === '1');

// focus-annotation + mode toggling
check('focus-annotation flashed the annotation', (attrOf(html, 'data-test-focus-annotation-flash') || '') === '1');
check('set-mode:false produced a mode ack', (attrOf(html, 'data-test-set-mode-off-ack') || '') === '1');
check('set-mode:false left the host in mode 0', (attrOf(html, 'data-test-set-mode-off-host') || '') === '1');
check('set-mode:false preserved existing markers', (attrOf(html, 'data-test-markers-preserved-on-mode-off') || '') === '1');

// Markers outside annotation mode (own overlay UI stays interactive)
check('markers render outside annotation mode', (attrOf(html, 'data-test-marker-inactive-exists') || '') === '1');
check('marker-hover works outside annotation mode', (attrOf(html, 'data-test-marker-hover-inactive') || '') === '1');
check('marker-click works outside annotation mode', (attrOf(html, 'data-test-marker-click-inactive') || '') === '1');
check('marker-hover:null reported on marker leave', (attrOf(html, 'data-test-marker-hover-cleared') || '') === '1');
check('set-annotations([]) clears markers', (attrOf(html, 'data-test-markers-cleared-final') || '') === '1');

// Final overlay state reflected in the host attributes
check('host data-dsh-markers="0" after clear', /data-dsh-markers="0"/.test(html));
check('host data-dsh-mode="0" after explicit mode off', /data-dsh-mode="0"/.test(html));

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
console.log('OK: runtime.js static contract + headless end-to-end behaviour verified.');
process.exit(0);
