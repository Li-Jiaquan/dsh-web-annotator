// Host-half unit + integration tests for the DSH web annotator plugin.
// Run: node test/host.test.mjs   (Node 22, no third-party dependencies)
//
// The tests bind real loopback servers: a fake "target website" and the proxy
// server under test. Everything is closed again so the process exits by itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apply,
  buildProxyDocument,
  createAnnotatorServer,
  escapeHtmlText,
  inject,
  normalizeTargetUrl,
  ASSET_CACHE_CONTROL,
  ASSET_PATH,
  ENDPOINT_PATH,
  HEALTH_PATH,
  PROXY_PATH,
  RUNTIME_CACHE_CONTROL,
  RUNTIME_PATH,
  TARGET_URL_META_NAME,
  VENDOR_CACHE_CONTROL,
  VENDOR_PATH,
  VENDOR_PREFIX,
} from '../index.js';

// A stand-in for runtime.js so this suite never depends on page-runtime's file.
const RUNTIME_STUB =
  '/* dsh-web-annotator runtime (test stub) */\n' +
  'window.__dshWebAnnotatorStub = true;\n';

const PAGE_HTML =
  '<!doctype html><html><head><title>Target</title></head>' +
  '<body><main id="app"><button id="save">Save</button></main></body></html>';

const CSS_TEXT = 'body { color: #123456; }';
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 250, 255];
// >4MB: over the /asset per-entry cache cap, so it must never be cached.
const HUGE_ASSET_BYTES = Buffer.alloc(4 * 1024 * 1024 + 1024, 0x5a);

// ---------------------------------------------------------------- helpers

function listenServer(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    try {
      server.closeAllConnections?.();
    } catch {
      /* best effort */
    }
    server.close(() => resolve());
  });
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  return {
    status: response.status,
    type: response.headers.get('content-type') || '',
    cache: response.headers.get('cache-control') || '',
    frame: response.headers.get('x-frame-options') || '',
    csp: response.headers.get('content-security-policy') || '',
    text: await response.text(),
  };
}

async function getJson(url) {
  const response = await fetch(url, { redirect: 'follow' });
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get('content-type') || '',
    cache: response.headers.get('cache-control') || '',
    json: text === '' ? null : JSON.parse(text),
    text,
  };
}

async function getBytes(url, headers) {
  const response = await fetch(url, { redirect: 'follow', headers });
  return {
    status: response.status,
    type: response.headers.get('content-type') || '',
    cache: response.headers.get('cache-control') || '',
    etag: response.headers.get('etag') || '',
    body: Buffer.from(await response.arrayBuffer()),
  };
}

/** Fake target website used by the proxy integration test. */
function createTargetHandler() {
  return (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      /* keep default */
    }
    switch (pathname) {
      case '/ok':
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          // A proxied page must NOT inherit the target's embedding locks: the
          // injected HTML has to allow same-origin /runtime.js, /vendor and
          // /asset requests (SPEC §10.2).
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'none'",
        });
        res.end(PAGE_HTML);
        return;
      case '/bare':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<h1>bare</h1>');
        return;
      case '/sniff':
        // No content-type at all: the proxy must sniff HTML by body shape.
        res.writeHead(200);
        res.end('<!doctype html><html><head></head><body><p>sniff</p></body></html>');
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head></head><body>' + 'x'.repeat(8192) + '</body></html>');
        return;
      case '/plain':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('hello');
        return;
      case '/binary':
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2, 3, 250, 255]));
        return;
      case '/redirect':
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      case '/redirect-to': {
        // Test-only cross-server redirect: `to` is an absolute http(s) URL.
        const redirectTo =
          new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('to') || '/ok';
        res.writeHead(302, { location: redirectTo });
        res.end();
        return;
      }
      case '/notfound':
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      case '/boom':
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      // --- v1.1 static assets used by GET /asset -------------------------
      case '/style.css':
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
        res.end(CSS_TEXT);
        return;
      case '/pixel.png':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from(PNG_BYTES));
        return;
      case '/asset-notype':
        res.writeHead(200); // deliberately no Content-Type
        res.end('raw-bytes');
        return;
      case '/asset-missing':
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('missing asset');
        return;
      case '/asset-error':
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('asset boom');
        return;
      case '/asset-big':
        // Declared size exceeds the small assetLimitBytes of the test proxy.
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '4096' });
        res.end('x'.repeat(4096));
        return;
      case '/asset-huge':
        // Complete 200 response above the 4MB /asset cache entry cap.
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(HUGE_ASSET_BYTES.length),
        });
        res.end(HUGE_ASSET_BYTES);
        return;
      case '/asset-slow': {
        // Never answers in time for a 100ms asset timeout.
        const timer = setTimeout(() => {
          try {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('late');
          } catch {
            /* client already gone */
          }
        }, 5000);
        if (typeof timer.unref === 'function') timer.unref();
        res.on('close', () => clearTimeout(timer));
        return;
      }
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('unknown');
    }
  };
}

function encodeTarget(url) {
  return encodeURIComponent(url);
}

/** Minimal in-process invocation of a registered webServer route. */
function invokeRoute(route, { method = 'GET', url = ENDPOINT_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let statusCode = 0;
    let bodyText = '';
    const req = { method, url, headers: {} };
    const res = {
      headersSent: false,
      statusCode: 0,
      setHeader(name, value) {
        headers[String(name).toLowerCase()] = value;
      },
      writeHead(code, extraHeaders) {
        statusCode = code;
        this.statusCode = code;
        this.headersSent = true;
        for (const [name, value] of Object.entries(extraHeaders || {})) {
          headers[String(name).toLowerCase()] = value;
        }
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) {
          bodyText += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        }
        resolve({ status: statusCode, headers, text: bodyText, body: bodyText });
      },
      destroy(error) {
        reject(error instanceof Error ? error : new Error('response destroyed'));
      },
    };
    try {
      Promise.resolve(route.handler(req, res)).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

// ---------------------------------------------------------------- pure helpers

test('module exports the frozen host contract (inject + helpers)', () => {
  assert.ok(Array.isArray(inject), 'inject is exported as an array');
  assert.deepEqual(inject, ['webServer'], 'inject declares the webServer hard dependency');
  assert.equal(typeof apply, 'function', 'apply exported');
  assert.equal(typeof normalizeTargetUrl, 'function', 'normalizeTargetUrl exported');
  assert.equal(typeof buildProxyDocument, 'function', 'buildProxyDocument exported');
  assert.equal(typeof createAnnotatorServer, 'function', 'createAnnotatorServer exported');
  assert.equal(ENDPOINT_PATH, '/dsh-web-annotator/endpoint', 'endpoint path constant');
  assert.equal(RUNTIME_PATH, '/runtime.js', 'runtime path constant');
  assert.equal(HEALTH_PATH, '/health', 'health path constant');
  assert.equal(PROXY_PATH, '/proxy', 'proxy path constant');
  // v1.1 (SPEC §10.2)
  assert.equal(VENDOR_PATH, '/vendor/html2canvas.min.js', 'vendor path constant');
  assert.equal(VENDOR_PREFIX, '/vendor/', 'vendor prefix constant');
  assert.equal(ASSET_PATH, '/asset', 'asset path constant');
  // v1.5 (SPEC §14.2)
  assert.equal(TARGET_URL_META_NAME, 'dsh-web-annotator-url', 'target-url meta name constant');
  // v1.7 (performance)
  assert.equal(VENDOR_CACHE_CONTROL, 'public, max-age=31536000, immutable', 'vendor cache-control');
  assert.equal(RUNTIME_CACHE_CONTROL, 'no-cache', 'runtime cache-control');
  assert.equal(ASSET_CACHE_CONTROL, 'private, max-age=60', 'asset cache-control');
});

test('normalizeTargetUrl accepts http(s) and rejects everything else', () => {
  const ok = normalizeTargetUrl('http://localhost:3000/app?a=1');
  assert.ok(ok.url instanceof URL, 'http url accepted');
  assert.equal(ok.url.origin, 'http://localhost:3000');
  assert.ok(normalizeTargetUrl('https://example.com/').url instanceof URL, 'https accepted');

  for (const bad of [
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'ftp://example.com/x',
    '',
    '   ',
    'not a url',
    null,
    undefined,
    42,
  ]) {
    const result = normalizeTargetUrl(bad);
    assert.ok(result && typeof result.error === 'string' && result.error.length > 0,
      'rejected: ' + JSON.stringify(bad));
  }

  const credentials = normalizeTargetUrl('http://user:pass@example.com/');
  assert.ok(credentials.error, 'credentials rejected');

  const tooLong = normalizeTargetUrl('http://example.com/' + 'a'.repeat(100), { maxLength: 20 });
  assert.ok(tooLong.error, 'over-long url rejected');

  const onlyHttps = normalizeTargetUrl('http://example.com/', { protocols: ['https:'] });
  assert.ok(onlyHttps.error, 'protocol option honoured');
});

test('buildProxyDocument injects base, meta and runtime script exactly once', () => {
  const out = buildProxyDocument(PAGE_HTML, {
    targetUrl: 'http://localhost:3000/page',
    runtimePath: '/runtime.js',
  });
  assert.equal((out.match(/<base /g) || []).length, 1, 'exactly one base tag');
  assert.ok(out.includes('href="http://localhost:3000/page"'), 'base href is the target url');
  assert.ok(out.includes('<meta name="dsh-web-annotator" content="1"'), 'meta marker');
  assert.ok(out.includes('data-dsh-web-annotator'), 'data marker present');
  // v1.5 (SPEC §14.2): the final target URL is exposed via a meta tag too.
  assert.ok(
    out.includes('<meta name="dsh-web-annotator-url" content="http://localhost:3000/page">'),
    'target-url meta carries the url',
  );
  assert.equal(
    (out.match(/<meta name="dsh-web-annotator-url"/g) || []).length,
    1,
    'target-url meta injected once',
  );
  assert.equal((out.match(/\/runtime\.js/g) || []).length, 1, 'runtime script injected once');
  assert.ok(out.includes('<script defer src="/runtime.js"></script>'), 'defer runtime script');
  assert.ok(out.indexOf('<base') < out.indexOf('</head>'), 'base inserted inside head');
  assert.ok(out.indexOf('<meta name=') < out.indexOf('</head>'), 'meta inserted inside head');
  assert.ok(out.indexOf('/runtime.js') < out.indexOf('</body>'), 'script before </body>');
  assert.ok(out.includes('<button id="save">Save</button>'), 'original markup untouched');
  assert.ok(out.startsWith('<!doctype html>'), 'doctype stays first');

  // An existing <base> must be kept and not duplicated.
  const withBase = buildProxyDocument(
    '<html><head><base href="/x/"></head><body></body></html>',
    { targetUrl: 'http://t/', runtimePath: '/r.js' },
  );
  assert.equal((withBase.match(/<base /g) || []).length, 1, 'existing base kept');
  assert.ok(withBase.includes('<base href="/x/">'), 'existing base unchanged');
  assert.ok(
    withBase.includes('<meta name="dsh-web-annotator-url" content="http://t/">'),
    'target-url meta still injected when the page has its own base',
  );

  // Uppercase tags still match; no head -> synthetic head; no body -> append.
  const upper = buildProxyDocument(
    '<HTML><HEAD><TITLE>x</TITLE></HEAD><BODY>y</BODY></HTML>',
    { targetUrl: 'http://t/', runtimePath: '/r.js' },
  );
  assert.ok(upper.includes('<HEAD><base href="http://t/"><meta'), 'base after uppercase HEAD');
  assert.ok(upper.indexOf('</script>') > upper.indexOf('y'), 'script appended before uppercase BODY close');

  const noHead = buildProxyDocument('<!doctype html><body>hi</body>', {
    targetUrl: 'http://t/',
    runtimePath: '/r.js',
  });
  assert.ok(noHead.startsWith('<!doctype html>'), 'doctype preserved when synthesizing head');
  assert.ok(noHead.includes('<base href="http://t/"><head></head>'), 'base + synthetic head inserted');
  assert.ok(noHead.indexOf('/r.js') < noHead.indexOf('</body>'), 'script injected before body close');

  const noBody = buildProxyDocument('<html><head></head><p>tail</p></html>', {
    targetUrl: 'http://t/',
    runtimePath: '/r.js',
  });
  assert.ok(noBody.endsWith('<script defer src="/r.js"></script>'), 'script appended without body tag');

  // v1.5: `finalUrl` (post-redirect) wins over `targetUrl` for base and meta.
  const redirected = buildProxyDocument(PAGE_HTML, {
    targetUrl: 'https://example.com/start',
    finalUrl: 'https://example.com/final/page',
    runtimePath: '/r.js',
  });
  assert.ok(redirected.includes('href="https://example.com/final/page"'), 'base uses finalUrl');
  assert.ok(redirected.includes('content="https://example.com/final/page"'), 'meta uses finalUrl');
  assert.ok(!redirected.includes('https://example.com/start'), 'request url is not used in base/meta');

  // §2.4 keeps `&` raw in <base href>; §14.2 requires the meta content to be
  // HTML-escaped, so the browser reads the original URL back from the attribute.
  const ampersand = buildProxyDocument('<head></head>', {
    targetUrl: 'http://t/search?a=1&b=2',
    runtimePath: '/r.js',
  });
  assert.ok(ampersand.includes('href="http://t/search?a=1&b=2"'), 'raw ampersand in base href');
  assert.ok(
    ampersand.includes('content="http://t/search?a=1&amp;b=2"'),
    'target-url meta is HTML-escaped',
  );
});

test('escapeHtmlText escapes text but leaves ordinary characters alone', () => {
  assert.equal(
    escapeHtmlText('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
  );
  assert.equal(escapeHtmlText('plain text 123'), 'plain text 123');
  assert.equal(escapeHtmlText(null), '');
});

// ---------------------------------------------------------------- proxy server

test('proxy server: health, runtime.js, html injection, passthrough and errors', async (t) => {
  const target = http.createServer(createTargetHandler());
  const targetPort = await listenServer(target);
  const targetOrigin = 'http://127.0.0.1:' + targetPort;

  // Bind through the raw node:http API (the same way the acceptance harness
  // binds it) to prove createAnnotatorServer returns a real http.Server.
  const proxy = createAnnotatorServer({ runtimeSource: RUNTIME_STUB });
  const proxyPort = await listenServer(proxy);
  const base = 'http://127.0.0.1:' + proxyPort;

  t.after(async () => {
    await closeServer(proxy);
    await closeServer(target);
  });

  // --- liveness ---------------------------------------------------------
  const health = await getJson(base + HEALTH_PATH);
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true });
  assert.match(health.type, /application\/json/);
  assert.equal(health.cache, 'no-store', 'health is no-store');

  // --- runtime.js -------------------------------------------------------
  const runtime = await getText(base + RUNTIME_PATH);
  assert.equal(runtime.status, 200);
  assert.match(runtime.type, /application\/javascript/);
  assert.ok(runtime.text.includes('dsh-web-annotator'), 'runtime body served');
  assert.equal(runtime.cache, 'no-cache', 'runtime.js is revalidated (no-cache)');

  // --- html proxy: injection -------------------------------------------
  const page = await getText(
    base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/ok'),
  );
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.equal(page.cache, 'no-store', 'proxied page is no-store');
  assert.equal(page.frame, '', 'no X-Frame-Options is added');
  assert.equal(page.csp, '', 'no target CSP is copied (would block /vendor and /asset)');
  assert.ok(page.text.includes('<base href="' + targetOrigin + '/ok">'), 'base href = target url');
  assert.ok(page.text.includes('data-dsh-web-annotator'), 'injection marker present');
  assert.ok(
    page.text.includes('<script defer src="' + base + RUNTIME_PATH + '"></script>'),
    'runtime script src is absolute (not hijacked by <base href>)',
  );
  assert.ok(page.text.includes('<button id="save">Save</button>'), 'target markup preserved');
  assert.ok(page.text.indexOf('<base') < page.text.indexOf('</head>'), 'base inside head');
  assert.ok(page.text.indexOf('/runtime.js') < page.text.indexOf('</body>'), 'script before body close');

  // --- html proxy: no head / no content-type sniffing -------------------
  const bare = await getText(base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/bare'));
  assert.equal(bare.status, 200);
  assert.ok(bare.text.includes('<base href="' + targetOrigin + '/bare">'), 'bare page gets base');
  assert.ok(bare.text.includes('<head></head>'), 'synthetic head for bare page');
  assert.ok(bare.text.endsWith('</script>'), 'bare page gets runtime script appended');

  const sniffed = await getText(base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/sniff'));
  assert.equal(sniffed.status, 200);
  assert.ok(sniffed.text.includes('data-dsh-web-annotator'), 'html sniffed without content-type');
  assert.ok(sniffed.text.includes('<p>sniff</p>'), 'sniffed body preserved');

  // --- redirect handling ------------------------------------------------
  const redirected = await getText(
    base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/redirect'),
  );
  assert.equal(redirected.status, 200);
  assert.ok(redirected.text.includes('<base href="' + targetOrigin + '/ok">'), 'base uses final url');

  // --- non-html passthrough --------------------------------------------
  const plain = await getText(
    base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/plain'),
  );
  assert.equal(plain.status, 200);
  assert.match(plain.type, /text\/plain/);
  assert.equal(plain.text, 'hello', 'non-html body passed through unchanged');
  assert.equal(plain.cache, 'no-store');

  const binaryResponse = await fetch(
    base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/binary'),
  );
  assert.equal(binaryResponse.status, 200);
  const binaryBytes = Buffer.from(await binaryResponse.arrayBuffer());
  assert.deepEqual([...binaryBytes], [0, 1, 2, 3, 250, 255], 'binary body passed through');

  // --- invalid input ----------------------------------------------------
  for (const bad of [
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'http://user:pass@127.0.0.1:' + targetPort + '/ok',
  ]) {
    const rejected = await getJson(base + PROXY_PATH + '?url=' + encodeTarget(bad));
    assert.equal(rejected.status, 400, 'invalid url -> 400: ' + bad);
    assert.equal(rejected.json.ok, false);
    assert.equal(rejected.cache, 'no-store');
  }
  const missing = await getJson(base + PROXY_PATH);
  assert.equal(missing.status, 400, 'missing url -> 400');

  // --- upstream failures ------------------------------------------------
  const boom = await getJson(base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/boom'));
  assert.equal(boom.status, 502, 'upstream HTTP 500 -> 502');
  assert.equal(boom.json.ok, false);
  assert.match(boom.type, /application\/json/);

  // A closed target port must be reported as 502, not crash the proxy.
  const dead = http.createServer();
  const deadPort = await listenServer(dead);
  await closeServer(dead);
  const refused = await getJson(
    base + PROXY_PATH + '?url=' + encodeTarget('http://127.0.0.1:' + deadPort + '/'),
  );
  assert.equal(refused.status, 502, 'connection refused -> 502');
  assert.equal(refused.json.ok, false);

  // --- routing / method guards -----------------------------------------
  const notFound = await getJson(base + '/no-such-route');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.cache, 'no-store');

  const post = await fetch(base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/ok'), {
    method: 'POST',
  });
  assert.equal(post.status, 405, 'non-GET -> 405');
  await post.text();

  const head = await fetch(base + HEALTH_PATH, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()), '', 'HEAD has no body');

  // The proxy is still healthy after all the error paths.
  const stillHealthy = await getJson(base + HEALTH_PATH);
  assert.deepEqual(stillHealthy.json, { ok: true }, 'proxy survives error paths');
});

test('proxy server: oversize HTML is rejected with 502 and the server survives', async (t) => {
  const target = http.createServer(createTargetHandler());
  const targetPort = await listenServer(target);
  const targetOrigin = 'http://127.0.0.1:' + targetPort;

  const proxy = createAnnotatorServer({ runtimeSource: RUNTIME_STUB, htmlLimitBytes: 1024 });
  const proxyPort = await listenServer(proxy);
  const base = 'http://127.0.0.1:' + proxyPort;

  t.after(async () => {
    await closeServer(proxy);
    await closeServer(target);
  });

  const tooBig = await getJson(
    base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/big'),
  );
  assert.equal(tooBig.status, 502, 'oversize html -> 502');
  assert.equal(tooBig.json.ok, false);
  assert.match(tooBig.json.error, /limit/);

  const health = await getJson(base + HEALTH_PATH);
  assert.equal(health.status, 200, 'server still healthy after oversize rejection');
});

// ---------------------------------------------------------------- v1.1 vendor / asset

test('proxy server: v1.1 vendored html2canvas and /asset same-origin proxy', async (t) => {
  const target = http.createServer(createTargetHandler());
  const targetPort = await listenServer(target);
  const targetOrigin = 'http://127.0.0.1:' + targetPort;

  const proxy = createAnnotatorServer({ runtimeSource: RUNTIME_STUB });
  const proxyPort = await listenServer(proxy);
  const base = 'http://127.0.0.1:' + proxyPort;

  // Small budgets let the timeout / size-limit paths run in milliseconds.
  const tightProxy = createAnnotatorServer({ runtimeSource: RUNTIME_STUB, assetTimeoutMs: 100 });
  const tightPort = await listenServer(tightProxy);
  const tightBase = 'http://127.0.0.1:' + tightPort;
  const smallProxy = createAnnotatorServer({ runtimeSource: RUNTIME_STUB, assetLimitBytes: 1024 });
  const smallPort = await listenServer(smallProxy);
  const smallBase = 'http://127.0.0.1:' + smallPort;
  const brokenVendorProxy = createAnnotatorServer({
    runtimeSource: RUNTIME_STUB,
    vendorSource: () => {
      throw new Error('vendor file missing');
    },
  });
  const brokenPort = await listenServer(brokenVendorProxy);
  const brokenBase = 'http://127.0.0.1:' + brokenPort;

  t.after(async () => {
    await closeServer(proxy);
    await closeServer(tightProxy);
    await closeServer(smallProxy);
    await closeServer(brokenVendorProxy);
    await closeServer(target);
  });

  // --- vendored html2canvas (SPEC §10.2) --------------------------------
  const vendor = await getText(base + VENDOR_PATH);
  assert.equal(vendor.status, 200, 'vendor build served');
  assert.match(vendor.type, /application\/javascript/, 'vendor is javascript');
  assert.equal(vendor.cache, 'public, max-age=31536000, immutable', 'vendor is immutable-cacheable');
  assert.ok(vendor.text.length > 100000, 'vendor build is the full html2canvas (>100000 chars)');
  assert.ok(vendor.text.includes('html2canvas'), 'vendor body really is html2canvas');

  const otherVendor = await getJson(base + VENDOR_PREFIX + 'other.js');
  assert.equal(otherVendor.status, 404, 'other /vendor/* -> 404');

  const brokenVendor = await getJson(brokenBase + VENDOR_PATH);
  assert.equal(brokenVendor.status, 500, 'vendor read failure -> 500');
  assert.equal(brokenVendor.json.ok, false);

  const vendorPost = await fetch(base + VENDOR_PATH, { method: 'POST' });
  assert.equal(vendorPost.status, 405, 'vendor non-GET -> 405');
  await vendorPost.text();

  // --- /asset: content-type and body passthrough ------------------------
  const css = await getText(base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/style.css'));
  assert.equal(css.status, 200, 'css fetched through /asset');
  assert.match(css.type, /text\/css/, 'css content-type passed through');
  assert.equal(css.text, CSS_TEXT, 'css body passed through');
  assert.equal(css.cache, 'private, max-age=60', 'asset response is private max-age=60');

  const cssBlob = await getText(
    base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/style.css') + '&responseType=blob',
  );
  assert.equal(cssBlob.status, 200, 'responseType param is accepted and ignored');
  assert.equal(cssBlob.text, CSS_TEXT);

  const pngResponse = await fetch(
    base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/pixel.png'),
  );
  assert.equal(pngResponse.status, 200, 'png fetched through /asset');
  assert.match(pngResponse.headers.get('content-type') || '', /image\/png/);
  assert.deepEqual(
    [...Buffer.from(await pngResponse.arrayBuffer())],
    PNG_BYTES,
    'png bytes passed through unchanged',
  );

  // html2canvas 1.4.1 appends `&url=` because the proxy already contains '?',
  // so real requests look like
  // `/asset?url=&url=<encoded>&responseType=blob`. The LAST non-empty `url`
  // must win: taking the first (empty) one used to return 400 and silently
  // drop every cross-origin image from the screenshot.
  const dupePng = await fetch(
    base + ASSET_PATH + '?url=&url=' + encodeTarget(targetOrigin + '/pixel.png') + '&responseType=blob',
  );
  assert.equal(dupePng.status, 200, 'html2canvas-style ?url=&url= request works');
  assert.match(dupePng.headers.get('content-type') || '', /image\/png/);
  assert.equal(dupePng.headers.get('cache-control') || '', 'private, max-age=60');
  assert.deepEqual(
    [...Buffer.from(await dupePng.arrayBuffer())],
    PNG_BYTES,
    'html2canvas-style ?url=&url= bytes passed through',
  );

  const dupeBad = await getJson(
    base + ASSET_PATH + '?url=&url=' + encodeTarget('file:///C:/Windows/win.ini'),
  );
  assert.equal(dupeBad.status, 400, 'last non-empty url is still validated (file:// -> 400)');
  assert.equal(dupeBad.json.ok, false);

  const allEmpty = await getJson(base + ASSET_PATH + '?url=&url=');
  assert.equal(allEmpty.status, 400, 'all-empty url params -> 400');

  const notype = await getText(
    base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/asset-notype'),
  );
  assert.equal(notype.status, 200);
  assert.match(notype.type, /application\/octet-stream/, 'missing upstream type -> octet-stream');
  assert.equal(notype.text, 'raw-bytes');

  // --- /asset: upstream status passthrough ------------------------------
  const missingAsset = await getText(
    base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/asset-missing'),
  );
  assert.equal(missingAsset.status, 404, 'upstream 404 passed through');
  assert.equal(missingAsset.text, 'missing asset');
  assert.match(missingAsset.type, /text\/plain/);

  const errorAsset = await getText(
    base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/asset-error'),
  );
  assert.equal(errorAsset.status, 500, 'upstream 500 passed through (unlike /proxy)');
  assert.equal(errorAsset.text, 'asset boom');

  // --- /asset: validation / method / network errors ---------------------
  for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>']) {
    const rejected = await getJson(base + ASSET_PATH + '?url=' + encodeTarget(bad));
    assert.equal(rejected.status, 400, 'invalid asset url -> 400: ' + bad);
    assert.equal(rejected.json.ok, false);
    assert.equal(rejected.cache, 'no-store');
  }
  const missingParam = await getJson(base + ASSET_PATH);
  assert.equal(missingParam.status, 400, 'missing asset url -> 400');

  const assetPost = await fetch(
    base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/style.css'),
    { method: 'POST' },
  );
  assert.equal(assetPost.status, 405, 'asset non-GET -> 405');
  await assetPost.text();

  const dead = http.createServer();
  const deadPort = await listenServer(dead);
  await closeServer(dead);
  const refused = await getJson(
    base + ASSET_PATH + '?url=' + encodeTarget('http://127.0.0.1:' + deadPort + '/x.png'),
  );
  assert.equal(refused.status, 502, 'asset connection refused -> 502');
  assert.equal(refused.json.ok, false);

  // --- /asset: timeout 504 and size limit 502 (SPEC §10.2) --------------
  const timedOut = await getJson(
    tightBase + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/asset-slow'),
  );
  assert.equal(timedOut.status, 504, 'asset timeout -> 504');
  assert.equal(timedOut.json.ok, false);
  assert.match(timedOut.json.error, /timed out/);

  const tooBig = await getJson(
    smallBase + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/asset-big'),
  );
  assert.equal(tooBig.status, 502, 'asset over size limit -> 502');
  assert.equal(tooBig.json.ok, false);
  assert.match(tooBig.json.error, /limit/);

  const stillHealthy = await getJson(smallBase + HEALTH_PATH);
  assert.deepEqual(stillHealthy.json, { ok: true }, 'server survives asset errors');
});

// ---------------------------------------------------------------- v1.5 (SPEC §14.2)

test('proxy server: v1.5 final URL base/meta and https auto fallback', async (t) => {
  const targetA = http.createServer(createTargetHandler());
  const targetAPort = await listenServer(targetA);
  const targetAOrigin = 'http://127.0.0.1:' + targetAPort;
  const targetB = http.createServer(createTargetHandler());
  const targetBPort = await listenServer(targetB);
  const targetBOrigin = 'http://127.0.0.1:' + targetBPort;

  const proxy = createAnnotatorServer({ runtimeSource: RUNTIME_STUB });
  const proxyPort = await listenServer(proxy);
  const base = 'http://127.0.0.1:' + proxyPort;

  t.after(async () => {
    await closeServer(proxy);
    await closeServer(targetA);
    await closeServer(targetB);
  });

  // --- 302 across servers: base + meta use the final response URL --------
  const shortUrl = targetAOrigin + '/redirect-to?to=' + encodeTarget(targetBOrigin + '/ok');
  const redirected = await getText(base + PROXY_PATH + '?url=' + encodeTarget(shortUrl));
  assert.equal(redirected.status, 200, 'redirected page proxied');
  assert.ok(
    redirected.text.includes('<base href="' + targetBOrigin + '/ok">'),
    'base href = final URL on server B',
  );
  assert.ok(
    redirected.text.includes(
      '<meta name="dsh-web-annotator-url" content="' + targetBOrigin + '/ok">',
    ),
    'url meta = final URL on server B',
  );
  assert.ok(
    !redirected.text.includes('href="' + targetAOrigin + '/redirect-to'),
    'base href is not the pre-redirect request URL',
  );
  assert.ok(redirected.text.includes('<button id="save">Save</button>'), 'final body proxied');

  // Query strings: base href keeps `&` raw, the meta content is HTML-escaped.
  const withQuery =
    targetAOrigin + '/redirect-to?to=' + encodeTarget(targetBOrigin + '/ok?a=1&b=2');
  const redirectedQuery = await getText(base + PROXY_PATH + '?url=' + encodeTarget(withQuery));
  assert.equal(redirectedQuery.status, 200);
  assert.ok(
    redirectedQuery.text.includes('<base href="' + targetBOrigin + '/ok?a=1&b=2">'),
    'base keeps raw ampersand',
  );
  assert.ok(
    redirectedQuery.text.includes(
      '<meta name="dsh-web-annotator-url" content="' + targetBOrigin + '/ok?a=1&amp;b=2">',
    ),
    'url meta ampersand is HTML-escaped',
  );

  // --- auto=1: https network failure retries once as plain http ---------
  const httpsToHttpPort = 'https://127.0.0.1:' + targetBPort + '/ok';
  const auto = await getText(
    base + PROXY_PATH + '?url=' + encodeTarget(httpsToHttpPort) + '&auto=1',
  );
  assert.equal(auto.status, 200, 'auto=1 https network failure -> http fallback 200');
  assert.ok(
    auto.text.includes('<base href="http://127.0.0.1:' + targetBPort + '/ok">'),
    'base href = http fallback URL',
  );
  assert.ok(
    auto.text.includes(
      '<meta name="dsh-web-annotator-url" content="http://127.0.0.1:' + targetBPort + '/ok">',
    ),
    'url meta = http fallback URL',
  );

  // Without auto=1 the identical https input is not retried.
  const explicitHttps = await getJson(
    base + PROXY_PATH + '?url=' + encodeTarget(httpsToHttpPort),
  );
  assert.equal(explicitHttps.status, 502, 'explicit https (no auto) -> 502');
  assert.equal(explicitHttps.json.ok, false);

  // auto=1 with an http URL needs no fallback and works normally.
  const autoHttp = await getText(
    base + PROXY_PATH + '?url=' + encodeTarget(targetBOrigin + '/ok') + '&auto=1',
  );
  assert.equal(autoHttp.status, 200, 'auto=1 with an http url still works');
  assert.ok(autoHttp.text.includes('<base href="' + targetBOrigin + '/ok">'));

  // HTTP error responses are not network failures: no retry, same 502 shape.
  const boom = await getJson(
    base + PROXY_PATH + '?url=' + encodeTarget(targetBOrigin + '/boom') + '&auto=1',
  );
  assert.equal(boom.status, 502, 'upstream HTTP 500 with auto=1 -> 502 (no retry)');

  // Both attempts failing -> 502 with a combined message; server survives.
  const dead = http.createServer();
  const deadPort = await listenServer(dead);
  await closeServer(dead);
  const bothFail = await getJson(
    base + PROXY_PATH + '?url=' + encodeTarget('https://127.0.0.1:' + deadPort + '/ok') + '&auto=1',
  );
  assert.equal(bothFail.status, 502, 'https+http fallback both failing -> 502');
  assert.match(bothFail.json.error, /fallback/i);

  const stillHealthy = await getJson(base + HEALTH_PATH);
  assert.deepEqual(stillHealthy.json, { ok: true }, 'server survives v1.5 error paths');
});

// ---------------------------------------------------------------- v1.7 (performance)

test('proxy server: v1.7 asset LRU cache, cache headers and runtime ETag/304', async (t) => {
  const baseHandler = createTargetHandler();
  const upstreamHits = new Map();
  const target = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      /* keep default */
    }
    upstreamHits.set(pathname, (upstreamHits.get(pathname) || 0) + 1);
    baseHandler(req, res);
  });
  const targetPort = await listenServer(target);
  const targetOrigin = 'http://127.0.0.1:' + targetPort;

  // File-backed runtime.js: exercises the real mtime+size read cache and ETag.
  const proxy = createAnnotatorServer();
  const proxyPort = await listenServer(proxy);
  const base = 'http://127.0.0.1:' + proxyPort;

  // Separate server whose runtime.js points at a temp file we can rewrite.
  const runtimeFile = join(
    tmpdir(),
    `dsh-web-annotator-runtime-${process.pid}-${Date.now()}.js`,
  );
  writeFileSync(runtimeFile, '/* runtime v1 dsh-web-annotator */\n');
  const fileProxy = createAnnotatorServer({ runtimeFilePath: runtimeFile });
  const fileProxyPort = await listenServer(fileProxy);
  const fileBase = 'http://127.0.0.1:' + fileProxyPort;

  t.after(async () => {
    await closeServer(proxy);
    await closeServer(fileProxy);
    await closeServer(target);
    try {
      unlinkSync(runtimeFile);
    } catch {
      /* already gone */
    }
  });

  // --- /asset LRU: a second request must not touch the upstream ----------
  const pixelProxyUrl = base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/pixel.png');
  const assetStarted = performance.now();
  const first = await getBytes(pixelProxyUrl);
  const assetFirstMs = performance.now() - assetStarted;
  assert.equal(first.status, 200);
  assert.deepEqual([...first.body], PNG_BYTES, 'first asset body is correct');
  assert.equal(first.cache, 'private, max-age=60', 'asset response is private max-age=60');
  assert.equal(upstreamHits.get('/pixel.png'), 1, 'first asset request reaches upstream');

  const secondStarted = performance.now();
  const second = await getBytes(pixelProxyUrl);
  const assetSecondMs = performance.now() - secondStarted;
  assert.equal(second.status, 200);
  assert.deepEqual([...second.body], PNG_BYTES, 'cached asset body is correct');
  assert.equal(second.cache, 'private, max-age=60', 'cached response keeps the cache header');
  assert.equal(
    upstreamHits.get('/pixel.png'),
    1,
    'second asset request is served from the LRU cache (upstream hit only once)',
  );

  // --- >4MB responses are never cached ---------------------------------
  const hugeProxyUrl = base + ASSET_PATH + '?url=' + encodeTarget(targetOrigin + '/asset-huge');
  const hugeFirst = await getBytes(hugeProxyUrl);
  assert.equal(hugeFirst.status, 200);
  assert.equal(hugeFirst.body.length, HUGE_ASSET_BYTES.length, 'huge asset body size');
  assert.equal(upstreamHits.get('/asset-huge'), 1);
  const hugeSecond = await getBytes(hugeProxyUrl);
  assert.equal(hugeSecond.status, 200);
  assert.equal(hugeSecond.body.length, HUGE_ASSET_BYTES.length);
  assert.equal(
    upstreamHits.get('/asset-huge'),
    2,
    '>4MB asset is not cached: upstream is contacted again',
  );

  // --- cache headers on the other routes --------------------------------
  const vendor = await getBytes(base + VENDOR_PATH);
  assert.equal(vendor.cache, 'public, max-age=31536000, immutable', 'vendor is immutable-cacheable');
  const health = await getJson(base + HEALTH_PATH);
  assert.equal(health.cache, 'no-store', '/health stays no-store');
  const page = await getText(base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/ok'));
  assert.equal(page.cache, 'no-store', '/proxy stays no-store');

  // --- runtime.js: no-cache + strong ETag + 304 -------------------------
  const runtimeFirst = await getBytes(base + RUNTIME_PATH);
  assert.equal(runtimeFirst.status, 200);
  assert.ok(runtimeFirst.body.length > 1000, 'runtime.js body served');
  assert.equal(runtimeFirst.cache, 'no-cache', '/runtime.js must be revalidated (no-cache)');
  assert.match(
    runtimeFirst.etag,
    /^"[0-9a-f]+-[0-9a-f]+"$/,
    'ETag is a strong mtime+size token in quotes',
  );

  const notModified = await fetch(base + RUNTIME_PATH, {
    headers: { 'if-none-match': runtimeFirst.etag },
  });
  assert.equal(notModified.status, 304, 'If-None-Match matching the ETag -> 304');
  assert.equal(await notModified.text(), '', '304 response has an empty body');
  assert.equal(notModified.headers.get('etag'), runtimeFirst.etag, '304 repeats the ETag');
  assert.equal(notModified.headers.get('cache-control'), 'no-cache');

  const staleEtag = await getBytes(base + RUNTIME_PATH, { 'if-none-match': '"stale-etag"' });
  assert.equal(staleEtag.status, 200, 'non-matching If-None-Match -> 200');

  // --- runtime.js file changes invalidate the read cache ----------------
  const fileRuntime1 = await getBytes(fileBase + RUNTIME_PATH);
  assert.equal(fileRuntime1.status, 200);
  assert.match(fileRuntime1.body.toString('utf8'), /runtime v1/, 'temp runtime v1 served');
  const etagV1 = fileRuntime1.etag;
  assert.ok(etagV1.length > 0, 'temp runtime has an ETag');
  // Rewrite with different content (and size): mtime+size must invalidate.
  writeFileSync(runtimeFile, '/* runtime v2 changed dsh-web-annotator */\n');
  const fileRuntime2 = await getBytes(fileBase + RUNTIME_PATH);
  assert.equal(fileRuntime2.status, 200);
  assert.match(fileRuntime2.body.toString('utf8'), /runtime v2 changed/, 'changed runtime.js served');
  assert.notEqual(fileRuntime2.etag, etagV1, 'ETag changes when runtime.js changes');

  // --- measurement line for the report ----------------------------------
  const proxy50Url = base + PROXY_PATH + '?url=' + encodeTarget(targetOrigin + '/ok');
  await fetch(proxy50Url).then((response) => response.text());
  const proxyStarted = performance.now();
  for (let index = 0; index < 50; index += 1) {
    const response = await fetch(proxy50Url);
    await response.text();
  }
  const proxyAverageMs = (performance.now() - proxyStarted) / 50;
  const runtimeSteadyStarted = performance.now();
  for (let index = 0; index < 20; index += 1) {
    const response = await fetch(base + RUNTIME_PATH);
    await response.text();
  }
  const runtimeAverageMs = (performance.now() - runtimeSteadyStarted) / 20;
  console.log(
    '[host.test v1.7] asset first=' +
      assetFirstMs.toFixed(2) +
      'ms second=' +
      assetSecondMs.toFixed(2) +
      'ms (upstream hits: first=' +
      upstreamHits.get('/pixel.png') +
      ' total-for-huge=' +
      upstreamHits.get('/asset-huge') +
      '); proxy50 avg=' +
      proxyAverageMs.toFixed(2) +
      'ms; runtime avg=' +
      runtimeAverageMs.toFixed(2) +
      'ms; runtime bytes=' +
      runtimeFirst.body.length,
  );
});

test('proxy server: start() binds loopback and close() stops it idempotently', async () => {
  const proxy = createAnnotatorServer({ runtimeSource: RUNTIME_STUB });
  const info = await proxy.start();
  assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback origin');
  assert.equal(proxy.origin, info.origin, 'origin property agrees with start()');
  assert.ok(proxy.listening, 'server reports listening');
  const health = await getJson(info.origin + HEALTH_PATH);
  assert.deepEqual(health.json, { ok: true });

  await proxy.close();
  await proxy.close(); // idempotent
  assert.equal(proxy.listening, false, 'server stopped');
  assert.equal(proxy.origin, '', 'origin cleared after close');
});

test('proxy server: close() during an in-flight start() still tears the listener down', async () => {
  const proxy = createAnnotatorServer({ runtimeSource: RUNTIME_STUB });
  const starting = proxy.start();
  await proxy.close(); // close wins the race: it must await the bind, then close it
  const info = await starting;
  assert.equal(proxy.listening, false, 'no server is left listening after the race');
  await assert.rejects(
    fetch(info.origin + HEALTH_PATH, { signal: AbortSignal.timeout(2000) }),
    'the closed proxy origin is unreachable',
  );
});

// ---------------------------------------------------------------- apply()

test('apply() registers the exact endpoint route, serves 503 then 200, and cleans up', async () => {
  const routes = [];
  const cleanups = [];
  const fakeCtx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index !== -1) routes.splice(index, 1);
        };
      },
    },
    effect(fn) {
      const cleanup = fn();
      const disposer = async () => {
        if (typeof cleanup === 'function') await cleanup();
      };
      cleanups.push(disposer);
      return disposer;
    },
  };

  const cleanupAll = async () => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      await cleanups[index]();
    }
  };

  try {
    apply(fakeCtx);

    assert.equal(routes.length, 1, 'exactly one route registered');
    const [route] = routes;
    assert.equal(route.kind, 'exact', 'exact route kind');
    assert.equal(route.path, ENDPOINT_PATH, 'endpoint path');
    assert.equal(typeof route.handler, 'function', 'route handler');

    // The first poll may already see the ready state; if it does not, the
    // documented 503 {ok:false,starting:true} shape must be returned.
    const first = await invokeRoute(route);
    if (first.status === 503) {
      const payload = JSON.parse(first.text);
      assert.equal(payload.ok, false);
      assert.equal(payload.starting, true);
      assert.equal(first.headers['cache-control'], 'no-store');
    } else {
      assert.equal(first.status, 200, 'first poll is either 503 or 200');
    }

    let ready = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await invokeRoute(route);
      if (response.status === 200) {
        ready = response;
        break;
      }
      await delay(20);
    }
    assert.ok(ready, 'endpoint becomes ready');

    const payload = JSON.parse(ready.text);
    assert.equal(payload.ok, true);
    assert.match(payload.proxyOrigin, /^http:\/\/127\.0\.0\.1:\d+$/, 'proxyOrigin is loopback');
    assert.equal(payload.runtimePath, RUNTIME_PATH);
    assert.equal(payload.version, 1);
    assert.match(ready.headers['content-type'], /application\/json/);
    assert.equal(ready.headers['cache-control'], 'no-store');

    // The announced origin really serves the proxy API.
    const health = await getJson(payload.proxyOrigin + HEALTH_PATH);
    assert.deepEqual(health.json, { ok: true }, 'announced proxyOrigin works');

    // Applying again on the same context must restart instead of throwing on
    // a duplicate route registration.
    apply(fakeCtx);
    assert.equal(routes.length, 1, 'route not duplicated by re-apply');
    let secondPayload = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await invokeRoute(routes[0]);
      if (response.status === 200) {
        secondPayload = JSON.parse(response.text);
        break;
      }
      await delay(20);
    }
    assert.ok(secondPayload, 're-applied endpoint becomes ready');
    assert.notEqual(secondPayload.proxyOrigin, payload.proxyOrigin, 'restart binds a fresh port');
    const restartedHealth = await getJson(secondPayload.proxyOrigin + HEALTH_PATH);
    assert.deepEqual(restartedHealth.json, { ok: true }, 'restarted proxy is reachable');
  } finally {
    await cleanupAll();
  }

  assert.equal(routes.length, 0, 'route disposed on cleanup');
});
