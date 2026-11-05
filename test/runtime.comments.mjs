#!/usr/bin/env node
/**
 * dsh-web-annotator — page-runtime v1.2 interaction test (SPEC §11.4)
 *
 * Headless Chrome loads test/runtime.comments.html (which pulls in
 * ../runtime.js). The page harness behaves like client.js: it mirrors
 * annotations, clicks markers, types/saves/deletes comments and presses the
 * floating action bar. This script asserts the recorded observations:
 *   - marker click opens the in-page popover (inside the shadow root, never in
 *     the page DOM), with title "元素批注 1" / "文本批注 2", width <= 320px,
 *     inside the viewport, above the marker or flipped below near the top edge,
 *     never covering the marker;
 *   - saving posts `annotation-comment {id, comment}` (top level), marks the
 *     marker as commented and closes the popover; reopening refills the textarea;
 *   - Esc / outside click / close button close the popover (Esc must not report
 *     `escape` while it is open);
 *   - delete posts `annotation-delete {id}` and removes the marker;
 *   - set-annotations `comment` restores the commented state and prefill;
 *   - the floating bar shows "批注 N 条 · 写入对话框" + 清空, hides with 0
 *     annotations, posts `request-submit`, and on 清空 posts one
 *     `annotation-delete` per annotation before clearing locally;
 *   - a parent `clear` clears locally without extra annotation-delete messages;
 *   - no runtime/page errors.
 *
 * No third-party dependencies. If no Chrome/Edge is installed: SKIP + exit 0.
 *
 * Usage: node test/runtime.comments.mjs
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_PATH = path.resolve(HERE, '..', 'runtime.js');
const PAGE_PATH = path.resolve(HERE, 'runtime.comments.html');

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
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, windowsHide: true, ...options },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
}

async function runHeadless(browser, url) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'dsha-comments-'));
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
      '--virtual-time-budget=15000',
      '--dump-dom',
      url,
    ];
    return await execFileAsync(browser, args);
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ====================================================================== *
 * 1. static contract checks
 * ====================================================================== */

console.log('runtime.js — v1.2 interaction static contract checks');

let source = '';
try {
  source = await readFile(RUNTIME_PATH, 'utf8');
} catch (error) {
  console.error(`  FAIL  cannot read runtime.js: ${error.message}`);
  process.exit(1);
}

const staticChecks = [
  ['annotation-comment message', source.includes("'annotation-comment'")],
  ['annotation-delete message', source.includes("'annotation-delete'")],
  ['request-submit message', source.includes("'request-submit'")],
  ['top-level message helper (SPEC §11.2)', source.includes('function postTop')],
  ['popover lives in the shadow root', source.includes("className = 'dsha-pop'")],
  ['popover textarea + save/delete/close', source.includes('dsha-pop-input') && source.includes('dsha-pop-save') && source.includes('dsha-pop-delete') && source.includes('dsha-pop-close')],
  ['popover max width 320px', source.includes('max-width:320px') || source.includes('maxWidth')],
  ['floating action bar', source.includes("className = 'dsha-bar'")],
  ['action bar send label (v1.4 写入对话框)', source.includes("barSend.textContent = '写入对话框'")],
  ['action bar send title/aria-label', source.includes("setAttr(barSend, 'title', '写入对话框')") && source.includes("setAttr(barSend, 'aria-label', '写入对话框')")],
  ['action bar clear label', source.includes("'清空'")],
  ['bar count text 批注 N 条', source.includes("'批注 ' + count + ' 条 · '")],
  ['commented marker state', source.includes('is-commented')],
  ['focus-annotation opens the popover', source.includes('openPopover(id)')],
  ['set-annotations restores comment', source.includes('raw.comment')],
  ['Esc closes popover before escape', source.includes('if (state.popoverOpen)')],
  ['bar clear deletes each annotation first', source.includes("postTop('annotation-delete', { id: ids[i] })")],
  ['bar clear collects ids before clearing', source.includes('state.annotations.map')],
  ['popover positioned above/below marker', source.includes('markerY - half - gap - height')],
  ['v1.3 space passthrough helpers', source.includes('enterPassthrough') && source.includes('exitPassthrough')],
  ['Space detected via event.code', source.includes("event.code === 'Space'")],
  ['Space keydown is not preventDefault-ed', source.includes('Do NOT preventDefault')],
  ['passthrough hint text', source.includes('松开空格键恢复批注模式')],
  ['passthrough data attribute for tests', source.includes("'data-dsh-passthrough'")],
  ['passthrough root class (pointer-events none)', source.includes('dsha-passthrough')],
  ['editable targets never enter passthrough', source.includes('isEditableTarget')],
  ['keyup and window blur exit passthrough', source.includes('function onKeyUp') && source.includes('function onWindowBlur')],
  ['set-mode active=false clears passthrough', source.includes('if (!next && state.passthrough) exitPassthrough();')],
];

for (const [name, ok] of staticChecks) check(name, ok);

/* ====================================================================== *
 * 2. headless end-to-end checks
 * ====================================================================== */

console.log('\nruntime.comments.html — headless v1.2 popover/action-bar e2e');

const browser = findBrowser();
if (!browser) {
  console.log('SKIP: no Chrome/Edge found (looked at CHROME_PATH, DSH_CHROME_PATH and standard install paths).');
  console.log(`static checks: ${total - failures.length}/${total} passed, 0 failed`);
  process.exit(failures.length > 0 ? 1 : 0);
}

console.log(`  browser: ${browser}`);
const pageUrl = pathToFileURL(PAGE_PATH).href;
console.log(`  page:    ${pageUrl}`);

const run = await runHeadless(browser, pageUrl);
const html = run.stdout || '';
const status = attrOf(html, 'data-test-status');

if (!/id="dsh-web-annotator-root"/.test(html)) {
  console.log('  --- captured stdout (first 2000 chars) ---');
  console.log(html.slice(0, 2000) || '(empty)');
  if (run.stderr) console.log(`  --- stderr (first 1200 chars) ---\n${run.stderr.slice(0, 1200)}`);
  if (run.error) console.log(`  --- process error: ${run.error.code || ''} ${run.error.message || run.error}`);
}

check('dump-dom contains #dsh-web-annotator-root', /id="dsh-web-annotator-root"/.test(html));
check('in-page harness completed', status !== null, 'no data-test-status attribute');
check('in-page harness status is pass', status === 'pass', status === null ? 'missing' : `status=${status}`);
if (status === 'fail') {
  console.log(`  harness failed step: ${attrOf(html, 'data-test-failed-step') || '(unknown)'}`);
  const runtimeErrors = attrOf(html, 'data-test-runtime-errors');
  if (runtimeErrors) console.log(`  runtime errors: ${runtimeErrors}`);
}

// popover / bar are inside the shadow root
check('popover rendered inside the shadow root', attrOf(html, 'data-test-popover-in-shadow') === '1');
check('popover does not escape into the page DOM', attrOf(html, 'data-test-popover-not-escaped') === '1');
check('action bar rendered inside the shadow root', attrOf(html, 'data-test-bar-in-shadow') === '1');
check(
  'ready message carries the current target url',
  attrOf(html, 'data-test-ready-url') === '1',
  attrOf(html, 'data-test-ready-url-value'),
);
check('action bar hidden while there are no annotations', attrOf(html, 'data-test-bar-hidden-initial') === '1');
check('action bar count starts at 批注 0 条', attrOf(html, 'data-test-bar-count-initial') === '1');

check('annotation mode ack', attrOf(html, 'data-test-mode-ack') === '1');
check('two numbered markers', attrOf(html, 'data-test-marker-count-2') === '1');
check('action bar visible with annotations', attrOf(html, 'data-test-bar-visible') === '1');
check('action bar count shows 批注 2 条', attrOf(html, 'data-test-bar-count-2') === '1');

check('marker click opens the popover', attrOf(html, 'data-test-popover-opened') === '1');
check('popover title is 元素批注 1', attrOf(html, 'data-test-popover-title-a1') === '1');
check('popover width <= 320px', attrOf(html, 'data-test-popover-width') === '1');
check('popover stays inside the viewport', attrOf(html, 'data-test-popover-in-viewport') === '1');
check('popover prefers the space below the marker near the top edge', attrOf(html, 'data-test-popover-below-marker') === '1');
check('popover never covers the marker', attrOf(html, 'data-test-popover-not-cover-marker') === '1');
check('popover contains a textarea', attrOf(html, 'data-test-popover-input') === '1');

check('saving posts annotation-comment {id, comment}', attrOf(html, 'data-test-comment-sent') === '1');
check('marker shows the commented state', attrOf(html, 'data-test-marker-commented') === '1');
check('popover closes after saving', attrOf(html, 'data-test-popover-closed-after-save') === '1');
check('clicking the marker again reopens the popover', attrOf(html, 'data-test-popover-reopened') === '1');
check('reopened textarea is prefilled', attrOf(html, 'data-test-popover-prefilled') === '1');

check('Esc closes the popover', attrOf(html, 'data-test-escape-closes-popover') === '1');
check('Esc while the popover is open does not report escape', attrOf(html, 'data-test-no-escape-message') === '1');

check('text annotation popover title is 文本批注 2', attrOf(html, 'data-test-popover-title-a2') === '1');
check('popover flips above the lower marker', attrOf(html, 'data-test-popover-above-marker') === '1');
check('popover never covers the lower marker', attrOf(html, 'data-test-popover-not-cover-marker-2') === '1');
check('clicking outside closes the popover', attrOf(html, 'data-test-outside-click-closes') === '1');

check('focus-annotation opens the popover', attrOf(html, 'data-test-focus-opens-popover') === '1');
check('focus-annotation popover has the right title', attrOf(html, 'data-test-focus-popover-title') === '1');
check('close button closes the popover', attrOf(html, 'data-test-close-button-closes') === '1');

check('delete posts annotation-delete {id}', attrOf(html, 'data-test-delete-sent') === '1');
check('deleting removes the marker', attrOf(html, 'data-test-marker-count-1') === '1');
check('action bar count updates to 批注 1 条', attrOf(html, 'data-test-bar-count-1') === '1');
check('popover closes after deleting', attrOf(html, 'data-test-popover-closed-after-delete') === '1');

check('set-annotations comment restores the commented marker', attrOf(html, 'data-test-comment-restored-marker') === '1');
check('restored comment prefills the textarea', attrOf(html, 'data-test-restored-prefill') === '1');
check('saving an empty comment posts comment=""', attrOf(html, 'data-test-empty-comment-saved') === '1');
check('empty comment clears the commented marker state', attrOf(html, 'data-test-marker-uncommented') === '1');

check('floating bar send label is 写入对话框', attrOf(html, 'data-test-bar-send-label') === '1');
check('floating bar send title/aria-label are 写入对话框', attrOf(html, 'data-test-bar-send-aria') === '1');
check('floating bar send posts request-submit', attrOf(html, 'data-test-bar-send') === '1');
check(
  'floating bar 清空 posts one annotation-delete per annotation before clearing',
  attrOf(html, 'data-test-bar-clear-delete-count') === '1',
  `count=${attrOf(html, 'data-test-bar-clear-delete-count')}`,
);
check('floating bar 清空 deletes the remaining annotation id', attrOf(html, 'data-test-bar-clear-delete-id') === '1');
check('action bar hides after clearing', attrOf(html, 'data-test-bar-hidden-after-clear') === '1');
check('all markers removed after clearing', attrOf(html, 'data-test-markers-after-clear') === '1');

check('parent clear clears the page locally', attrOf(html, 'data-test-parent-clear-markers') === '1');
check('parent clear hides the action bar', attrOf(html, 'data-test-parent-clear-bar-hidden') === '1');
check('parent clear emits no extra annotation-delete', attrOf(html, 'data-test-parent-clear-no-deletes') === '1');

/* ---- v1.3 space passthrough (SPEC §12.1) ---- */
check('space passthrough: overlay root becomes click-through', attrOf(html, 'data-test-passthrough-on') === '1');
check(
  'space passthrough: hint bar shown with the right text, pointer-events none',
  ['data-test-passthrough-hint', 'data-test-passthrough-hint-text', 'data-test-passthrough-hint-pointer'].every(
    (name) => attrOf(html, name) === '1',
  ),
);
check(
  'space passthrough: hit layer and markers are pointer-events none',
  ['data-test-passthrough-hit-none', 'data-test-passthrough-marker-none'].every((name) => attrOf(html, name) === '1'),
);
check('space passthrough: real hit testing reaches the page button', attrOf(html, 'data-test-passthrough-page-under-pointer') === '1');
check('space passthrough: the page click handler runs', attrOf(html, 'data-test-passthrough-page-click') === '1');
check('space passthrough: no annotation is created by gestures', attrOf(html, 'data-test-passthrough-no-new-annotation') === '1');
check(
  'space passthrough: keyup restores hit layer + markers + hides the hint',
  [
    'data-test-passthrough-off',
    'data-test-passthrough-hint-hidden',
    'data-test-passthrough-hit-restored',
    'data-test-passthrough-marker-restored',
  ].every((name) => attrOf(html, name) === '1'),
);
check(
  'space passthrough: hit testing returns to the overlay',
  ['data-test-passthrough-hit-test-before', 'data-test-passthrough-hit-test-after'].every((name) => attrOf(html, name) === '1'),
);
check('space passthrough: Space inside the popover textarea stays a normal char', attrOf(html, 'data-test-passthrough-textarea-space') === '1');
check('space passthrough: Space inside a page input stays a normal char', attrOf(html, 'data-test-passthrough-input-space') === '1');
check(
  'space passthrough: set-mode active=false clears it',
  [
    'data-test-passthrough-on-before-mode-off',
    'data-test-passthrough-cleared-by-mode-off',
    'data-test-passthrough-mode-off',
  ].every((name) => attrOf(html, name) === '1'),
);
check('space passthrough: Space with annotation mode off does nothing', attrOf(html, 'data-test-passthrough-mode-off-no-enter') === '1');

check('no page/runtime errors during the whole flow', attrOf(html, 'data-test-no-errors') === '1');

console.log('  evidence:');
console.log(`    popover a1 rect (l,t,w,h): ${attrOf(html, 'data-test-popover-a1-rect')}`);
console.log(`    marker a1 rect (l,t,r,b):  ${attrOf(html, 'data-test-popover-a1-marker')}`);
console.log(`    popover a2 rect (l,t,w,h): ${attrOf(html, 'data-test-popover-a2-rect')}`);
console.log(`    message types seen:        ${attrOf(html, 'data-test-seen')}`);
console.log(`    annotation-delete total:   ${attrOf(html, 'data-test-delete-count')}`);

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
console.log('OK: runtime.js v1.2/v1.3 in-page popover + floating action bar + space passthrough verified.');
process.exit(0);
