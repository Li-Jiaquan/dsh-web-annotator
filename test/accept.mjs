// Lead acceptance harness for the DSH web-annotator bundle.
// Runs: manifest / locale / icon checks, syntax, contract consistency,
// and host-side integration tests against REAL local HTTP servers.
// Usage: node dsh-web-annotator/test/accept.mjs
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (error) {
    results.push({ name, ok: false, detail: error && error.stack ? error.stack : String(error) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}
function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}
function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, stdio: 'pipe' }).toString();
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => {
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    server.close(() => resolve());
  });
}
async function getText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  return { status: response.status, type: response.headers.get('content-type') || '', text: await response.text() };
}

// ---------------------------------------------------------------- manifest
await check('package.json is valid and declares the bundle + client', () => {
  const pkg = JSON.parse(read('package.json'));
  assert(pkg.name === '@local/dsh-web-annotator', 'name');
  assert(pkg.type === 'module', 'type module');
  assert(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch');
  assert(pkg.dsh.client && pkg.dsh.client.platform === 'web', 'dsh.client.platform');
  assert(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject array');
  assert(pkg.exports['./client'] === './client.js', 'exports ./client');
  assert(pkg.exports['./locale/*.json'] && pkg.exports['./icon'], 'locale/icon exports');
  for (const required of ['index.js', 'client.js', 'runtime.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert(pkg.files.includes(required), 'files must include ' + required);
  }
  return 'ok';
});

await check('cordis.patch.yml inserts exactly one web-annotator row', () => {
  const yaml = read('cordis.patch.yml');
  assert(/- insert:/.test(yaml), 'has insert');
  assert(/id:\s*web-annotator/.test(yaml), 'row id web-annotator');
  assert(/name:\s*'@local\/dsh-web-annotator'/.test(yaml), 'row package name');
  return 'ok';
});

await check('locale resources carry meta title + description (zh and en)', () => {
  for (const locale of ['en', 'zh']) {
    const dict = JSON.parse(read(join('locale', locale + '.json')));
    assert(dict.meta && typeof dict.meta.title === 'string' && dict.meta.title.length > 0, locale + ' meta.title');
    assert(typeof dict.meta.description === 'string' && dict.meta.description.length > 0, locale + ' meta.description');
  }
  const zh = JSON.parse(read(join('locale', 'zh.json')));
  assert(/[\u4e00-\u9fa5]/.test(zh.meta.title), 'zh title contains CJK');
  return 'ok';
});

await check('icon.svg is a bounded, valid SVG inside the package', () => {
  const svg = read('icon.svg');
  const size = statSync(join(root, 'icon.svg')).size;
  assert(size > 0 && size <= 256 * 1024, 'icon size <= 256KiB');
  assert(/^<svg[\s>]/.test(svg.trim()), 'starts with <svg');
  assert(/viewBox="[^"]+"/.test(svg), 'has viewBox');
  assert(/<\/svg>\s*$/.test(svg.trim()), 'closes svg');
  return size + ' bytes';
});

// ---------------------------------------------------------------- syntax
for (const file of ['index.js', 'client.js', 'runtime.js']) {
  await check('node --check ' + file, () => {
    run(process.execPath, ['--check', join(root, file)]);
    return 'syntax ok';
  });
}

// ---------------------------------------------------------------- contracts
const PAGE_TO_PARENT = ['ready', 'mode', 'select', 'marker-hover', 'marker-click', 'escape', 'error'];
const PARENT_TO_PAGE = ['hello', 'set-mode', 'set-annotations', 'focus-annotation', 'clear'];

await check('runtime.js exposes the injected root and the frozen message vocabulary', () => {
  const runtime = read('runtime.js');
  assert(runtime.includes('dsh-web-annotator-root'), 'overlay root id');
  assert(runtime.includes('dsh-web-annotator'), 'channel');
  assert(runtime.includes('attachShadow'), 'shadow root');
  for (const type of [...PAGE_TO_PARENT, ...PARENT_TO_PAGE]) {
    assert(runtime.includes("'" + type + "'") || runtime.includes('"' + type + '"'), 'runtime message type ' + type);
  }
  for (const field of ['elementPath', 'viewportRect', 'selectedText', 'textLocator', 'selectionRects', 'isFixed', 'xPercent']) {
    assert(runtime.includes(field), 'runtime anchor field ' + field);
  }
  return 'ok';
});

await check('client.js keeps the module-loader shape and registers the conversation view', () => {
  const client = read('client.js');
  assert(client.includes('__ModuleLoader__.load'), 'module loader');
  assert(client.includes('@local/dsh-web-annotator'), 'package id');
  assert(client.includes('conversation.view'), 'slot name');
  assert(client.includes("id: 'web-annotator'") || client.includes('id: "web-annotator"'), 'view id');
  assert(client.includes('inputActions.setDraft'), 'setDraft');
  // v1.4: the plugin never submits for the user; it writes the composer draft.
  assert(!client.includes('inputActions.submit'), 'no direct submit');
  assert(client.includes('# 网页批注'), 'prompt header');
  assert(client.includes('## 我的要求:'), 'prompt request section');
  assert(!client.includes('@deepseek-ai/dsh-client-ui-'), 'no harness client package imports');
  assert(!client.includes('document.body.appendChild'), 'no body appends');
  assert(!/React\.createElement\(\s*[A-Za-z]/.test(client), 'no JSX-ish createElement calls');
  assert(!/<[A-Z][A-Za-z]*[\s>]/.test(client.replace(/<style[\s\S]*?<\/style>/g, '')), 'no JSX-ish tags');
  return 'ok';
});

await check('client.js and runtime.js agree on every message type', () => {
  const client = read('client.js');
  const runtime = read('runtime.js');
  const missing = [];
  for (const type of PAGE_TO_PARENT) {
    if (!client.includes("'" + type + "'") && !client.includes('"' + type + '"')) missing.push('client<-runtime:' + type);
  }
  for (const type of PARENT_TO_PAGE) {
    if (!runtime.includes("'" + type + "'") && !runtime.includes('"' + type + '"')) missing.push('runtime<-client:' + type);
  }
  assert(missing.length === 0, 'missing message types: ' + missing.join(', '));
  return 'ok';
});

// ---------------------------------------------------------------- host logic
let host;
await check('index.js imports and exports the testable host helpers', async () => {
  host = await import(pathToFileURL(join(root, 'index.js')).href);
  for (const name of ['apply', 'normalizeTargetUrl', 'buildProxyDocument']) {
    assert(typeof host[name] === 'function', 'export ' + name);
  }
  assert(Array.isArray(host.inject) && host.inject.includes('webServer'), 'inject webServer');
  return 'ok';
});

await check('normalizeTargetUrl accepts http(s) and rejects everything else', () => {
  const ok = host.normalizeTargetUrl('http://localhost:3000/app?a=1');
  assert(ok && ok.url instanceof URL && ok.url.toString().startsWith('http://localhost:3000/'), 'http accepted');
  const httpsOk = host.normalizeTargetUrl('https://example.com/');
  assert(httpsOk && httpsOk.url instanceof URL, 'https accepted');
  for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'ftp://example.com/x', '', 'not a url']) {
    const result = host.normalizeTargetUrl(bad);
    assert(result && result.error, 'rejected: ' + JSON.stringify(bad));
  }
  const withCreds = host.normalizeTargetUrl('http://user:pass@example.com/');
  assert(withCreds && withCreds.error, 'rejected credentials in URL');
  return 'ok';
});

await check('buildProxyDocument injects base, meta and runtime script exactly once', () => {
  const html = '<!doctype html><html><head><title>t</title></head><body><main id="app">hi</main></body></html>';
  const out = host.buildProxyDocument(html, { targetUrl: 'http://localhost:3000/page', runtimePath: '/runtime.js' });
  assert((out.match(/<base /g) || []).length === 1, 'one base tag');
  assert(out.includes('href="http://localhost:3000/page"'), 'base href target url');
  assert(out.includes('name="dsh-web-annotator"'), 'meta marker');
  assert((out.match(/\/runtime\.js/g) || []).length === 1, 'runtime script once');
  assert(out.indexOf('<base') < out.indexOf('</head>'), 'base inside head');
  assert(out.indexOf('/runtime.js') < out.indexOf('</body>'), 'script before body end');
  const already = host.buildProxyDocument('<html><head><base href="/x/"></head><body></body></html>', { targetUrl: 'http://t/', runtimePath: '/r.js' });
  assert((already.match(/<base /g) || []).length === 1, 'existing base kept');
  return 'ok';
});

await check('host proxy integration: health, runtime, html injection, 400/502', async () => {
  const target = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>T</title></head><body><button id="b">Save</button></body></html>');
    } else if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    } else {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    }
  });
  const targetPort = await listen(target);
  assert(typeof host.createAnnotatorServer === 'function', 'createAnnotatorServer exported');
  const proxy = host.createAnnotatorServer({ runtimeSource: read('runtime.js') });
  const proxyPort = await listen(proxy);
  const base = 'http://127.0.0.1:' + proxyPort;
  try {
    const health = await getText(base + '/health');
    assert(health.status === 200, 'health 200');
    const runtime = await getText(base + '/runtime.js');
    assert(runtime.status === 200 && runtime.text.includes('dsh-web-annotator-root'), 'runtime.js served');
    const injected = await getText(base + '/proxy?url=' + encodeURIComponent('http://127.0.0.1:' + targetPort + '/ok'));
    assert(injected.status === 200, 'proxy 200');
    assert(injected.text.includes('<base href="http://127.0.0.1:' + targetPort + '/ok"'), 'proxy base href');
    assert(injected.text.includes('/runtime.js'), 'proxy runtime script');
    assert(injected.text.includes('Save'), 'proxy keeps markup');
    const plain = await getText(base + '/proxy?url=' + encodeURIComponent('http://127.0.0.1:' + targetPort + '/plain'));
    assert(plain.status === 200 && plain.text === 'hello', 'non-html passthrough');
    const bad = await getText(base + '/proxy?url=' + encodeURIComponent('file:///C:/Windows/win.ini'));
    assert(bad.status === 400, 'invalid url -> 400, got ' + bad.status);
    const missing = await getText(base + '/proxy');
    assert(missing.status === 400, 'missing url -> 400');
    const upstream = await getText(base + '/proxy?url=' + encodeURIComponent('http://127.0.0.1:' + targetPort + '/boom'));
    assert(upstream.status === 502, 'upstream 500 -> 502, got ' + upstream.status);
  } finally {
    await close(proxy);
    await close(target);
  }
  return 'ok';
});

await check('apply() registers the endpoint route, serves 200, and cleans up', async () => {
  const routes = [];
  const disposers = [];
  const fakeCtx = {
    effect(fn) {
      const disposer = fn();
      const wrapped = async () => { if (typeof disposer === 'function') await disposer(); };
      disposers.push(wrapped);
      return wrapped;
    },
    webServer: {
      register(route) {
        routes.push(route);
        const dispose = () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1); };
        disposers.push(dispose);
        return dispose;
      },
    },
  };
  const callEndpoint = () => new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/dsh-web-annotator/endpoint', headers: {} };
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
      end(body) { this.body = body; resolve({ code: this.statusCode, headers: this.headers, body }); },
    };
    Promise.resolve(routes[0].handler(req, res)).catch(reject);
  });
  try {
    host.apply(fakeCtx);
    assert(routes.length === 1, 'one route registered');
    assert(routes[0].path === '/dsh-web-annotator/endpoint', 'endpoint path');
    assert(routes[0].kind === 'exact', 'exact route');
    let payload = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      payload = await callEndpoint();
      if (payload.code === 200) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(payload && payload.code === 200, 'endpoint eventually 200, got ' + (payload && payload.code));
    const json = JSON.parse(payload.body);
    assert(json.ok === true && typeof json.proxyOrigin === 'string', 'endpoint payload');
    assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(json.proxyOrigin), 'proxyOrigin loopback origin');
    return 'endpoint 200, proxyOrigin=' + json.proxyOrigin;
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    assert(routes.length === 0, 'route disposed');
  }
});

// ---------------------------------------------------------------- v1.1 screenshots
await check('v1.1 host routes: /vendor serves html2canvas, /asset proxies bytes', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const target = http.createServer((req, res) => {
    if (req.url === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    } else if (req.url === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      res.end('body{color:#123}');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    }
  });
  const targetPort = await listen(target);
  const proxy = host.createAnnotatorServer({ runtimeSource: read('runtime.js') });
  const proxyPort = await listen(proxy);
  const base = 'http://127.0.0.1:' + proxyPort;
  try {
    const vendor = await fetch(base + '/vendor/html2canvas.min.js');
    const vendorText = await vendor.text();
    assert(vendor.status === 200, '/vendor 200, got ' + vendor.status);
    assert(/javascript/.test(vendor.headers.get('content-type') || ''), '/vendor content-type');
    assert(vendorText.length > 100000, '/vendor length > 100000, got ' + vendorText.length);
    const otherVendor = await fetch(base + '/vendor/other.js');
    assert(otherVendor.status === 404, 'unknown /vendor 404, got ' + otherVendor.status);

    const img = await fetch(base + '/asset?url=' + encodeURIComponent('http://127.0.0.1:' + targetPort + '/img.png'));
    const imgBytes = Buffer.from(await img.arrayBuffer());
    assert(img.status === 200, '/asset image 200, got ' + img.status);
    assert(/image\/png/.test(img.headers.get('content-type') || ''), '/asset content-type passthrough');
    assert(imgBytes.subarray(0, 8).equals(png.subarray(0, 8)), '/asset bytes passthrough');

    const css = await fetch(base + '/asset?url=' + encodeURIComponent('http://127.0.0.1:' + targetPort + '/style.css'));
    assert(css.status === 200, '/asset css 200');
    assert(/text\/css/.test(css.headers.get('content-type') || ''), '/asset css type');

    // html2canvas appends its own `url=` to a proxy value that already has a query,
    // so the real request carries an empty first `url` and the target in the second.
    const doubleUrl = await fetch(
      base + '/asset?url=&url=' + encodeURIComponent('http://127.0.0.1:' + targetPort + '/img.png') + '&responseType=blob',
    );
    const doubleBytes = Buffer.from(await doubleUrl.arrayBuffer());
    assert(doubleUrl.status === 200, '/asset double-url 200, got ' + doubleUrl.status);
    assert(/image\/png/.test(doubleUrl.headers.get('content-type') || ''), '/asset double-url content-type');
    assert(doubleBytes.subarray(0, 8).equals(png.subarray(0, 8)), '/asset double-url bytes');
    const doubleBad = await fetch(base + '/asset?url=&url=' + encodeURIComponent('file:///C:/Windows/win.ini'));
    assert(doubleBad.status === 400, '/asset double-url file: -> 400, got ' + doubleBad.status);

    const badScheme = await fetch(base + '/asset?url=' + encodeURIComponent('file:///C:/Windows/win.ini'));
    assert(badScheme.status === 400, '/asset file: -> 400, got ' + badScheme.status);
    const missing = await fetch(base + '/asset');
    assert(missing.status === 400, '/asset missing url -> 400, got ' + missing.status);
    const post = await fetch(base + '/asset?url=' + encodeURIComponent('http://127.0.0.1:' + targetPort + '/img.png'), { method: 'POST' });
    assert(post.status === 405, '/asset POST -> 405, got ' + post.status);
  } finally {
    await close(proxy);
    await close(target);
  }
  return 'ok';
});

await check('v1.1 contract strings: runtime capture + client screenshot attachments', () => {
  const runtime = read('runtime.js');
  for (const needle of ['capture-screenshots', 'html2canvas', '/vendor/html2canvas.min.js', '/asset?url=']) {
    assert(runtime.includes(needle), 'runtime.js must mention ' + needle);
  }
  const client = read('client.js');
  for (const needle of ['capture-screenshots', 'screenshots', 'screenshot-', 'toolbar.screenshots', 'status.capturing']) {
    assert(client.includes(needle), 'client.js must mention ' + needle);
  }
  const zh = JSON.parse(read('locale/zh.json'));
  for (const key of ['toolbar.screenshots', 'status.capturing', 'status.captureFailed', 'panel.screenshotAlt', 'prompt.screenshotHeader', 'prompt.screenshotLine']) {
    assert(typeof zh[key] === 'string' && zh[key].length > 0, 'zh locale key ' + key);
  }
  return 'ok';
});

await check('v1.2 interaction: in-page comment popover, no side list, two send triggers', () => {
  const runtime = read('runtime.js');
  for (const needle of ['request-submit', 'annotation-comment', 'annotation-delete']) {
    assert(runtime.includes(needle), 'runtime.js must mention ' + needle);
  }
  const client = read('client.js');
  for (const needle of ['request-submit', 'annotation-comment', 'annotation-delete', 'toolbar.send', 'dsha-send']) {
    assert(client.includes(needle), 'client.js must mention ' + needle);
  }
  // The right-side annotation list (v1.0/v1.1) must be gone from the rendered UI.
  for (const banned of ['dsha-panel', 'dsha-list', 'dsha-item', "h('aside'"]) {
    assert(!client.includes(banned), 'client.js must not render the removed annotation list: ' + banned);
  }
  const zh = JSON.parse(read('locale/zh.json'));
  assert(typeof zh['toolbar.send'] === 'string' && zh['toolbar.send'].length > 0, 'zh toolbar.send');
  return 'ok';
});

await check('v1.3: space passthrough browsing + full-page annotated screenshot', () => {
  const runtime = read('runtime.js');
  for (const needle of ['__page__', 'passthrough', '#e11d48', 'rgba(225,29,72']) {
    assert(runtime.includes(needle), 'runtime.js must mention ' + needle);
  }
  const client = read('client.js');
  for (const needle of ['screenshot-page.png', 'prompt.screenshotFullPage', '__page__']) {
    assert(client.includes(needle), 'client.js must mention ' + needle);
  }
  assert(!client.includes("SCREENSHOT_FILE_PREFIX + (index + 1)"), 'client.js must not emit per-annotation screenshot names');
  const zh = JSON.parse(read('locale/zh.json'));
  assert(typeof zh['prompt.screenshotFullPage'] === 'string' && zh['prompt.screenshotFullPage'].length > 0, 'zh prompt.screenshotFullPage');
  return 'ok';
});

await check('v1.4: draft-only handoff (no auto submit) + quiet status bar', () => {
  const client = read('client.js');
  assert(!client.includes('inputActions.submit'), 'client.js must not call inputActions.submit');
  for (const needle of ['status.drafted', 'toolbar.send', 'setDraft']) {
    assert(client.includes(needle), 'client.js must mention ' + needle);
  }
  // ready/annotating statuses must not be rendered any more.
  assert(!/setNotice\([^)]*status\.ready/.test(client), 'client must not show status.ready');
  assert(!/setNotice\([^)]*status\.annotating/.test(client), 'client must not show status.annotating');
  const runtime = read('runtime.js');
  assert(runtime.includes('写入对话框'), 'runtime floating bar must say 写入对话框');
  const zh = JSON.parse(read('locale/zh.json'));
  assert(typeof zh['status.drafted'] === 'string' && zh['status.drafted'].length > 0, 'zh status.drafted');
  assert(/写入对话框/.test(zh['toolbar.send'] || ''), 'zh toolbar.send must say 写入对话框');
  return 'ok';
});

await check('v1.5: address-bar scheme inference + in-page link navigation', () => {
  const client = read('client.js');
  for (const needle of ['normalizeUrlInput', 'auto=1', 'navigate', 'dsh-web-annotator-url']) {
    assert(client.includes(needle), 'client.js must mention ' + needle);
  }
  const runtime = read('runtime.js');
  for (const needle of ['navigate', 'dsh-web-annotator-url', 'window-open']) {
    assert(runtime.includes(needle), 'runtime.js must mention ' + needle);
  }
  const host = read('index.js');
  assert(host.includes('auto'), 'index.js must handle auto scheme fallback');
  assert(host.includes('dsh-web-annotator-url'), 'index.js must inject the final-url meta');
  return 'ok';
});

await check('v1.6: browser-style back / forward / reload in the toolbar', () => {
  const client = read('client.js');
  for (const needle of ['toolbar.back', 'toolbar.forward', 'toolbar.reload', '_r=', 'history']) {
    assert(client.includes(needle), 'client.js must mention ' + needle);
  }
  const zh = JSON.parse(read('locale/zh.json'));
  for (const key of ['toolbar.back', 'toolbar.forward', 'toolbar.reload']) {
    assert(typeof zh[key] === 'string' && zh[key].length > 0, 'zh locale key ' + key);
  }
  return 'ok';
});

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? (r.detail ? ' -- ' + r.detail : '') : '\n  ' + r.detail));
}
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exit(failed.length === 0 ? 0 : 1);
