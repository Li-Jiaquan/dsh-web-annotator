/**
 * DSH Web Annotator — host half.
 *
 * Starts a small HTTP proxy server on 127.0.0.1:0 (the "origin B" of the
 * contract) that:
 *   - serves the annotation runtime (`GET /runtime.js`),
 *   - proxies an untrusted target page and injects `<base>`, a marker meta tag
 *     and the runtime script (`GET /proxy?url=...`),
 *   - answers a liveness probe (`GET /health`).
 *
 * It also registers the main Harness route
 * `GET /dsh-web-annotator/endpoint`, which tells the Web UI client whether the
 * proxy origin is ready yet (the client polls; 503 while the port is starting).
 *
 * Contract: dsh-web-annotator/SPEC.md §2 (frozen). No third-party dependencies.
 */

import { createServer } from 'node:http';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

/**
 * Hard dependency declaration (SPEC.md §2): Cordis only activates this plugin
 * when the Harness web server carrier is present, so a profile without
 * `webServer` simply does not load the route half.
 */
export const inject = ['webServer'];

/** Main Harness route; the client polls this. */
export const ENDPOINT_PATH = '/dsh-web-annotator/endpoint';
/** Proxy-relative path of the injected page runtime. */
export const RUNTIME_PATH = '/runtime.js';
/** Proxy-relative path of the page proxy. */
export const PROXY_PATH = '/proxy';
/** Proxy-relative liveness probe. */
export const HEALTH_PATH = '/health';
/** Vendored html2canvas build served to the injected runtime (SPEC §10.2). */
export const VENDOR_PATH = '/vendor/html2canvas.min.js';
/** Any other `/vendor/*` request is a 404. */
export const VENDOR_PREFIX = '/vendor/';
/** Same-origin asset proxy used by html2canvas for cross-origin images. */
export const ASSET_PATH = '/asset';
/** Payload version reported by the endpoint route. */
export const PROTOCOL_VERSION = 1;

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_HTML_LIMIT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_BINARY_LIMIT_BYTES = 20 * 1024 * 1024;
/** `GET /asset` budget (SPEC §10.2): 10s timeout, 20MB body. */
export const DEFAULT_ASSET_TIMEOUT_MS = 10_000;
export const DEFAULT_ASSET_LIMIT_BYTES = 20 * 1024 * 1024;

/** HTTP cache headers (v1.7 performance work). */
export const VENDOR_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const RUNTIME_CACHE_CONTROL = 'no-cache';
export const ASSET_CACHE_CONTROL = 'private, max-age=60';

/** `/asset` in-memory LRU cache limits (v1.7). */
export const DEFAULT_ASSET_CACHE_MAX_ENTRIES = 64;
export const DEFAULT_ASSET_CACHE_MAX_BYTES = 24 * 1024 * 1024;
export const DEFAULT_ASSET_CACHE_TTL_MS = 120_000;
export const DEFAULT_ASSET_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

const DEFAULT_URL_MAX_LENGTH = 8192;
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

const ENDPOINT_META_TAG = '<meta name="dsh-web-annotator" content="1" data-dsh-web-annotator="1">';

/** Meta tag carrying the final (post-redirect) target URL (SPEC §14.2). */
export const TARGET_URL_META_NAME = 'dsh-web-annotator-url';

/** `ctx.effect` registration must yield a dispose function; one apply per ctx. */
const appliedContexts = new WeakMap();

/**
 * Validate and normalize the `url` query parameter of `GET /proxy`.
 *
 * @param {unknown} raw raw query value.
 * @param {{ protocols?: string[], maxLength?: number }} [options]
 * @returns {{ url: URL } | { error: string }}
 */
export function normalizeTargetUrl(raw, options = {}) {
  const protocols =
    Array.isArray(options?.protocols) && options.protocols.length > 0
      ? options.protocols.map((entry) => String(entry).toLowerCase())
      : ALLOWED_PROTOCOLS.slice();
  const maxLength =
    Number.isFinite(options?.maxLength) && options.maxLength > 0
      ? options.maxLength
      : DEFAULT_URL_MAX_LENGTH;

  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: 'missing url parameter' };
  }
  const candidate = raw.trim();
  if (candidate.length > maxLength) {
    return { error: `url is too long (max ${maxLength} characters)` };
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: 'invalid url' };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (!protocols.includes(protocol)) {
    return { error: `unsupported url protocol: ${protocol || '(none)'}` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { error: 'credentials in url are not allowed' };
  }
  if (!parsed.hostname) {
    return { error: 'url has no host' };
  }
  return { url: parsed };
}

/**
 * Inject `<base>`, the annotation meta tags and the runtime script into a
 * proxied HTML document. Rules: SPEC.md §2.4 + §14.2.
 *
 * @param {string} html original document.
 * @param {{ targetUrl?: string, finalUrl?: string, runtimePath?: string }} [opts]
 *   `finalUrl` is the post-redirect response URL; it takes precedence over
 *   `targetUrl` for both `<base href>` and the target-URL meta tag (backward
 *   compatible: without it, `targetUrl` is used for both).
 * @returns {string}
 */
export function buildProxyDocument(html, opts = {}) {
  let document = typeof html === 'string' ? html : String(html ?? '');
  const targetUrl = typeof opts?.targetUrl === 'string' ? opts.targetUrl : '';
  const finalUrl =
    typeof opts?.finalUrl === 'string' && opts.finalUrl !== '' ? opts.finalUrl : targetUrl;
  const runtimePath =
    typeof opts?.runtimePath === 'string' && opts.runtimePath !== '' ? opts.runtimePath : RUNTIME_PATH;

  const hasBase = /<base\b/i.test(document);
  // §2.4: no `&` escaping in the base href; §14.2: the meta content is HTML-escaped.
  const baseTag = `<base href="${escapeHtmlAttribute(finalUrl)}">`;
  const urlMetaTag = `<meta name="${TARGET_URL_META_NAME}" content="${escapeHtmlMetaContent(finalUrl)}">`;
  const headMatch = /<head\b[^>]*>/i.exec(document);

  if (headMatch) {
    const insertAt = headMatch.index + headMatch[0].length;
    const injection = (hasBase ? '' : baseTag) + ENDPOINT_META_TAG + urlMetaTag;
    document = document.slice(0, insertAt) + injection + document.slice(insertAt);
  } else {
    const injection =
      (hasBase ? '' : baseTag) + '<head></head>' + ENDPOINT_META_TAG + urlMetaTag;
    document = insertAtDocumentFront(document, injection);
  }

  const runtimeTag = `<script defer src="${escapeHtmlAttribute(runtimePath)}"></script>`;
  const bodyCloseMatch = /<\/body\s*>/i.exec(document);
  if (bodyCloseMatch) {
    document =
      document.slice(0, bodyCloseMatch.index) + runtimeTag + document.slice(bodyCloseMatch.index);
  } else {
    document += runtimeTag;
  }
  return document;
}

/**
 * Escape a value for an HTML text node. Not used for URLs: `&` must stay
 * untouched there (SPEC.md §2.4), attribute escaping only guards quotes.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Create the proxy server (not listening yet). Exported so it can be exercised
 * by unit tests without a Cordis context.
 *
 * @param {{
 *   runtimeSource?: string | Buffer | (() => string | Buffer | Promise<string | Buffer>),
 *   runtimeScriptPath?: string,
 *   vendorSource?: string | Buffer | (() => string | Buffer),
 *   fetchImpl?: typeof fetch,
 *   fetchTimeoutMs?: number,
 *   htmlLimitBytes?: number,
 *   binaryLimitBytes?: number,
 *   assetTimeoutMs?: number,
 *   assetLimitBytes?: number,
 *   assetCacheMaxEntries?: number,
 *   assetCacheMaxBytes?: number,
 *   assetCacheTtlMs?: number,
 *   assetCacheMaxEntryBytes?: number,
 *   runtimeFilePath?: string | URL,
 * }} [options]
 */
export function createAnnotatorServer(options = {}) {
  const config = {
    runtimeSource: options?.runtimeSource ?? null,
    runtimeScriptPath:
      typeof options?.runtimeScriptPath === 'string' ? options.runtimeScriptPath : '',
    vendorSource: options?.vendorSource ?? null,
    fetchImpl: typeof options?.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch,
    fetchTimeoutMs: positiveNumber(options?.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS),
    htmlLimitBytes: positiveNumber(options?.htmlLimitBytes, DEFAULT_HTML_LIMIT_BYTES),
    binaryLimitBytes: positiveNumber(options?.binaryLimitBytes, DEFAULT_BINARY_LIMIT_BYTES),
    assetTimeoutMs: positiveNumber(options?.assetTimeoutMs, DEFAULT_ASSET_TIMEOUT_MS),
    assetLimitBytes: positiveNumber(options?.assetLimitBytes, DEFAULT_ASSET_LIMIT_BYTES),
    assetCacheMaxEntries: positiveNumber(
      options?.assetCacheMaxEntries,
      DEFAULT_ASSET_CACHE_MAX_ENTRIES,
    ),
    assetCacheMaxBytes: positiveNumber(
      options?.assetCacheMaxBytes,
      DEFAULT_ASSET_CACHE_MAX_BYTES,
    ),
    assetCacheTtlMs: positiveNumber(options?.assetCacheTtlMs, DEFAULT_ASSET_CACHE_TTL_MS),
    assetCacheMaxEntryBytes: positiveNumber(
      options?.assetCacheMaxEntryBytes,
      DEFAULT_ASSET_CACHE_MAX_ENTRY_BYTES,
    ),
  };
  const runtimeFilePath = resolveRuntimeFilePath(options?.runtimeFilePath);
  const vendorFilePath = new URL('./vendor/html2canvas.min.js', import.meta.url);

  const server = createServer((req, res) => {
    handleProxyRequest(req, res).catch((error) => {
      try {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : undefined);
          return;
        }
        sendJson(req, res, 500, { ok: false, error: messageOf(error) });
      } catch {
        try {
          res.destroy();
        } catch {
          /* already gone */
        }
      }
    });
  });

  let origin = '';

  /** Actual loopback origin, whether the socket was bound by `start()` or by hand. */
  function currentOrigin() {
    if (origin !== '') return origin;
    try {
      const address = server.address();
      if (address && typeof address === 'object' && typeof address.port === 'number') {
        return `http://127.0.0.1:${address.port}`;
      }
    } catch {
      /* not bound yet */
    }
    return '';
  }

  /** Text of an injected `runtimeSource` (tests/stubs); empty when not injected. */
  function injectedRuntimeSourceText() {
    const source = config.runtimeSource;
    if (Buffer.isBuffer(source)) return source.toString('utf8');
    if (typeof source === 'string') return source;
    if (typeof source === 'function') {
      const produced = source();
      if (produced && typeof produced.then === 'function') {
        throw new Error('async runtimeSource is not supported');
      }
      return Buffer.isBuffer(produced) ? produced.toString('utf8') : String(produced ?? '');
    }
    return '';
  }

  let runtimeFileCache = null; // { key, source, etag }

  /**
   * Runtime source plus a strong ETag. File-backed sources are cached by
   * mtime+size (v1.7): the file is only re-read when it changes on disk.
   * Injected sources (tests/stubs) bypass the file cache and carry no ETag.
   *
   * @returns {{ source: string, etag: string }}
   */
  function loadRuntimeSource() {
    if (config.runtimeSource != null) {
      return { source: injectedRuntimeSourceText(), etag: '' };
    }
    const stats = statSync(runtimeFilePath);
    const key = `${stats.mtimeMs}:${stats.size}`;
    if (runtimeFileCache && runtimeFileCache.key === key) return runtimeFileCache;
    runtimeFileCache = {
      key,
      source: readFileSync(runtimeFilePath, 'utf8'),
      etag: `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
    };
    return runtimeFileCache;
  }

  /** Absolute URL: `<base href>` makes root-relative srcs resolve to the target. */
  function runtimeScriptSrc() {
    if (config.runtimeScriptPath !== '') return config.runtimeScriptPath;
    const base = currentOrigin();
    return base !== '' ? `${base}${RUNTIME_PATH}` : RUNTIME_PATH;
  }

  async function handleProxyRequest(req, res) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(req, res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(typeof req?.url === 'string' && req.url !== '' ? req.url : '/', 'http://127.0.0.1');
    } catch {
      sendJson(req, res, 404, { ok: false, error: 'not found' });
      return;
    }

    const pathname = requestUrl.pathname;
    try {
      if (pathname === HEALTH_PATH) {
        sendJson(req, res, 200, { ok: true });
        return;
      }
      if (pathname === RUNTIME_PATH) {
        serveRuntime(req, res);
        return;
      }
      if (pathname === VENDOR_PATH) {
        serveVendor(req, res);
        return;
      }
      if (pathname.startsWith(VENDOR_PREFIX)) {
        sendJson(req, res, 404, { ok: false, error: 'not found' });
        return;
      }
      if (pathname === ASSET_PATH) {
        await serveAsset(req, res, requestUrl);
        return;
      }
      if (pathname === PROXY_PATH) {
        await serveProxy(req, res, requestUrl);
        return;
      }
      sendJson(req, res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(req, res, 502, { ok: false, error: messageOf(error) });
    }
  }

  function serveRuntime(req, res) {
    let entry;
    try {
      entry = loadRuntimeSource();
    } catch {
      sendJson(req, res, 503, { ok: false, error: 'runtime.js is not available yet' });
      return;
    }
    const headers = {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': RUNTIME_CACHE_CONTROL,
    };
    if (entry.etag) {
      headers.etag = entry.etag;
      if (etagMatches(req?.headers?.['if-none-match'], entry.etag)) {
        sendNotModified(res, headers);
        return;
      }
    }
    writeResponse(req, res, 200, headers, entry.source);
  }

  /** Bytes of the vendored html2canvas build (SPEC §10.2). */
  function vendorSourceBuffer() {
    const source = config.vendorSource;
    if (Buffer.isBuffer(source)) return source;
    if (typeof source === 'string') return Buffer.from(source, 'utf8');
    if (typeof source === 'function') {
      const produced = source();
      if (produced && typeof produced.then === 'function') {
        throw new Error('async vendorSource is not supported');
      }
      return Buffer.isBuffer(produced) ? produced : Buffer.from(String(produced ?? ''), 'utf8');
    }
    return readFileSync(vendorFilePath);
  }

  /** `GET /vendor/html2canvas.min.js` only; any other vendor path is a 404. */
  function serveVendor(req, res) {
    let source;
    try {
      source = vendorSourceBuffer();
    } catch (error) {
      sendJson(req, res, 500, {
        ok: false,
        error: `vendor/html2canvas.min.js is not available: ${messageOf(error)}`,
      });
      return;
    }
    writeResponse(
      req,
      res,
      200,
      {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': VENDOR_CACHE_CONTROL,
      },
      source,
    );
  }

  /** One `/proxy` fetch attempt with the contract headers and timeout budget. */
  function proxyFetch(target) {
    return config.fetchImpl(target, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (DSH Web Annotator)',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
  }

  /** `http:` variant of an `https:` URL href (only the scheme changes). */
  function httpFallbackUrl(href) {
    return `http://${href.slice('https://'.length)}`;
  }

  /**
   * Fetch the proxied document, retrying once over plain HTTP when the caller
   * asked for `auto=1`, the target uses https and the first attempt failed at
   * the network layer (TLS/connection/timeout — no HTTP response received).
   *
   * A received HTTP response of any status is not a network failure, so 4xx/5xx
   * are never retried (SPEC §14.2).
   *
   * @returns {Promise<{ response: Response, usedUrl: string, fallback: boolean }>}
   */
  async function fetchProxyDocument(targetUrl, autoScheme) {
    let httpsError = null;
    try {
      const response = await proxyFetch(targetUrl);
      return { response, usedUrl: targetUrl, fallback: false };
    } catch (error) {
      httpsError = error;
    }
    if (!autoScheme || !targetUrl.startsWith('https://')) {
      throw httpsError;
    }
    const fallbackUrl = httpFallbackUrl(targetUrl);
    try {
      const response = await proxyFetch(fallbackUrl);
      return { response, usedUrl: fallbackUrl, fallback: true };
    } catch (fallbackError) {
      // Keep the combined message on `message` (not `cause`): the 502 body
      // reports which attempt failed instead of only the last low-level code.
      const combined = new Error(
        `${describeFetchFailure(httpsError, config.fetchTimeoutMs)}; ` +
          `http fallback failed (${describeFetchFailure(fallbackError, config.fetchTimeoutMs)})`,
      );
      combined.name = 'ProxyFallbackError';
      throw combined;
    }
  }

  /** @param {import('node:http').IncomingMessage} req */
  async function serveProxy(req, res, requestUrl) {
    const normalized = normalizeTargetUrl(requestUrl.searchParams.get('url'));
    if (!('url' in normalized)) {
      sendJson(req, res, 400, { ok: false, error: normalized.error });
      return;
    }
    const targetUrl = normalized.url.href;
    const autoScheme = requestUrl.searchParams.get('auto') === '1';

    let response;
    let usedUrl = targetUrl;
    try {
      const fetched = await fetchProxyDocument(targetUrl, autoScheme);
      response = fetched.response;
      usedUrl = fetched.usedUrl;
    } catch (error) {
      sendJson(req, res, 502, {
        ok: false,
        error: describeFetchFailure(error, config.fetchTimeoutMs),
      });
      return;
    }

    if (!response || typeof response.status !== 'number') {
      sendJson(req, res, 502, { ok: false, error: 'target request failed: empty response' });
      return;
    }
    if (response.status >= 500) {
      cancelResponseBody(response);
      sendJson(req, res, 502, {
        ok: false,
        error: `target responded with HTTP ${response.status}`,
      });
      return;
    }

    const contentTypeHeader =
      typeof response.headers?.get === 'function' ? response.headers.get('content-type') || '' : '';
    const contentType = contentTypeHeader.toLowerCase();
    // §14.2: <base href> and the URL meta tag use the final response URL after
    // redirects (or the request URL / http fallback URL when fetch has none).
    const finalUrl =
      typeof response.url === 'string' && response.url !== '' ? response.url : usedUrl;

    try {
      if (contentType.includes('text/html')) {
        await serveHtml(req, res, response, finalUrl);
        return;
      }
      if (contentType === '') {
        const buffer = await readResponseBuffer(response, config.htmlLimitBytes);
        const text = buffer.toString('utf8');
        if (looksLikeHtml(text)) {
          sendHtmlDocument(req, res, text, finalUrl);
          return;
        }
        writeResponse(req, res, 200, { 'content-type': 'application/octet-stream' }, buffer);
        return;
      }
      const buffer = await readResponseBuffer(response, config.binaryLimitBytes);
      writeResponse(
        req,
        res,
        200,
        { 'content-type': contentTypeHeader || 'application/octet-stream' },
        buffer,
      );
    } catch (error) {
      cancelResponseBody(response);
      if (error instanceof BodyTooLargeError) {
        sendJson(req, res, 502, { ok: false, error: error.message });
        return;
      }
      sendJson(req, res, 502, {
        ok: false,
        error: `failed to read target response: ${messageOf(error)}`,
      });
    }
  }

  async function serveHtml(req, res, response, finalUrl) {
    const buffer = await readResponseBuffer(response, config.htmlLimitBytes);
    sendHtmlDocument(req, res, buffer.toString('utf8'), finalUrl);
  }

  // --- /asset in-memory LRU cache (v1.7) --------------------------------
  /** @type {Map<string, { buffer: Buffer, contentType: string, expiresAt: number }>} */
  const assetCache = new Map();
  let assetCacheBytes = 0;

  function assetCacheDelete(url) {
    const existing = assetCache.get(url);
    if (!existing) return;
    assetCache.delete(url);
    assetCacheBytes -= existing.buffer.byteLength;
  }

  function assetCacheGet(url) {
    const entry = assetCache.get(url);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      assetCacheDelete(url);
      return null;
    }
    // Refresh recency: delete + re-insert moves the key to the end (LRU).
    assetCache.delete(url);
    assetCache.set(url, entry);
    return entry;
  }

  function assetCachePut(url, buffer, contentType) {
    // Only complete 200 responses below the per-entry cap were passed in.
    if (buffer.byteLength > config.assetCacheMaxEntryBytes) return;
    assetCacheDelete(url);
    assetCache.set(url, {
      buffer,
      contentType,
      expiresAt: Date.now() + config.assetCacheTtlMs,
    });
    assetCacheBytes += buffer.byteLength;
    while (
      (assetCache.size > config.assetCacheMaxEntries ||
        assetCacheBytes > config.assetCacheMaxBytes) &&
      assetCache.size > 0
    ) {
      const oldest = assetCache.keys().next();
      if (oldest.done) break;
      assetCacheDelete(oldest.value);
    }
  }

  /**
   * `GET /asset?url=...` (SPEC §10.2): same-origin fetch of a remote static
   * asset for the injected runtime (html2canvas proxy). Unlike `/proxy` this
   * never rewrites the body: upstream status, content-type and bytes pass
   * through. `&responseType=blob|text` is accepted and ignored.
   */
  async function serveAsset(req, res, requestUrl) {
    // html2canvas 1.4.1 builds the proxy URL as `proxy + '&url=' + ...` when
    // the proxy value already contains '?'. With the SPEC-mandated proxy
    // `origin + '/asset?url='` the real request therefore is
    // `GET /asset?url=&url=<encoded>&responseType=blob`: the first `url` param
    // is empty and the target is the last non-empty one. Taking the last
    // non-empty value (instead of the first) keeps those images in the
    // screenshot instead of silently dropping them with a 400.
    const assetParams = requestUrl.searchParams
      .getAll('url')
      .filter((value) => value !== '');
    const normalized = normalizeTargetUrl(
      assetParams.length > 0 ? assetParams[assetParams.length - 1] : '',
    );
    if (!('url' in normalized)) {
      sendJson(req, res, 400, { ok: false, error: normalized.error });
      return;
    }
    const targetUrl = normalized.url.href;

    const cached = assetCacheGet(targetUrl);
    if (cached) {
      writeResponse(
        req,
        res,
        200,
        { 'content-type': cached.contentType, 'cache-control': ASSET_CACHE_CONTROL },
        cached.buffer,
      );
      return;
    }

    let response;
    try {
      response = await config.fetchImpl(targetUrl, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (DSH Web Annotator)',
          accept: '*/*',
        },
        signal: AbortSignal.timeout(config.assetTimeoutMs),
      });
    } catch (error) {
      const name = error && typeof error === 'object' ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        sendJson(req, res, 504, {
          ok: false,
          error: `asset request timed out after ${Math.round(config.assetTimeoutMs / 1000)}s`,
        });
        return;
      }
      sendJson(req, res, 502, {
        ok: false,
        error: describeFetchFailure(error, config.assetTimeoutMs),
      });
      return;
    }

    if (!response || typeof response.status !== 'number') {
      sendJson(req, res, 502, { ok: false, error: 'asset request failed: empty response' });
      return;
    }

    const contentTypeHeader =
      typeof response.headers?.get === 'function' ? response.headers.get('content-type') || '' : '';

    try {
      const buffer = await readResponseBuffer(response, config.assetLimitBytes);
      const responseContentType = contentTypeHeader || 'application/octet-stream';
      // Only complete 200 responses are cacheable; >4MB entries are skipped by
      // assetCachePut itself (v1.7 limits). Error statuses stay no-store.
      if (response.status === 200) {
        assetCachePut(targetUrl, buffer, responseContentType);
      }
      writeResponse(
        req,
        res,
        response.status,
        {
          'content-type': responseContentType,
          'cache-control': response.status === 200 ? ASSET_CACHE_CONTROL : 'no-store',
        },
        buffer,
      );
    } catch (error) {
      cancelResponseBody(response);
      if (error instanceof BodyTooLargeError) {
        sendJson(req, res, 502, { ok: false, error: error.message });
        return;
      }
      sendJson(req, res, 502, {
        ok: false,
        error: `failed to read asset response: ${messageOf(error)}`,
      });
    }
  }

  function sendHtmlDocument(req, res, html, finalUrl) {
    const document = buildProxyDocument(html, {
      targetUrl: finalUrl,
      finalUrl,
      runtimePath: runtimeScriptSrc(),
    });
    writeResponse(req, res, 200, { 'content-type': 'text/html; charset=utf-8' }, document);
  }

  let startPromise = null;

  /**
   * Bind the proxy to 127.0.0.1:0 unless it is already listening.
   * @returns {Promise<{ origin: string, port: number }>}
   */
  function start() {
    if (server.listening) {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      return Promise.resolve({ origin, port });
    }
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        origin = `http://127.0.0.1:${port}`;
        resolve({ origin, port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(0, '127.0.0.1');
      } catch (error) {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        reject(error);
      }
    });
    // Allow a retry after a failed bind; the caller still sees the rejection.
    startPromise.catch(() => {
      startPromise = null;
    });
    return startPromise;
  }

  const nodeClose = server.close;

  /**
   * Idempotent cleanup: destroy open sockets, then close the listener. A bind
   * that is still in flight is awaited first — otherwise the listener could
   * come up after this call and stay open forever. Accepts an optional
   * Node-style callback (`server.close(cb)` also works); without a callback a
   * promise is returned.
   */
  function close(callback) {
    origin = '';
    const timers = [];
    const promise = new Promise((resolve) => {
      let done = false;
      const clearTimers = () => {
        for (const timer of timers) clearTimeout(timer);
      };
      const finish = () => {
        if (done) return;
        done = true;
        clearTimers();
        startPromise = null;
        resolve();
      };
      const later = (fn, ms) => {
        const timer = setTimeout(fn, ms);
        if (typeof timer.unref === 'function') timer.unref();
        timers.push(timer);
      };
      const closeNow = () => {
        if (done) return;
        if (!server.listening) {
          finish();
          return;
        }
        try {
          server.closeAllConnections?.();
        } catch {
          /* best effort */
        }
        try {
          nodeClose.call(server, finish);
        } catch {
          finish();
        }
      };
      // Hard stop, so one stuck socket can never keep the plugin alive.
      later(finish, 2000);
      if (server.listening) {
        closeNow();
        return;
      }
      const pendingStart = startPromise;
      if (pendingStart) {
        pendingStart.then(closeNow, finish);
        return;
      }
      // Not listening and no bind in flight: nothing to tear down.
      finish();
    });
    if (typeof callback === 'function') {
      promise.then(
        () => callback(null),
        () => callback(null),
      );
      return server;
    }
    return promise;
  }

  // The returned value *is* the node:http server (so a caller may bind it with
  // its own `listen()`, as the acceptance harness does), plus the plugin
  // lifecycle helpers used by `apply()`.
  server.start = start;
  server.close = close;
  Object.defineProperty(server, 'origin', {
    configurable: true,
    enumerable: false,
    get: currentOrigin,
  });
  return server;
}

/**
 * Host plugin entry point (SPEC.md §2): start the proxy and register the
 * endpoint route. Both registrations live inside `ctx.effect` so unmounting the
 * plugin closes the server and removes the route.
 *
 * @param {*} ctx Cordis plugin context with `webServer` injected.
 */
export function apply(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('dsh-web-annotator: apply() requires a plugin context');
  }
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-web-annotator: the webServer service is not available');
  }
  if (typeof ctx.effect !== 'function') {
    throw new Error('dsh-web-annotator: ctx.effect is not available');
  }

  // Re-applying on the same context must not throw on the duplicate route.
  const previousDispose = appliedContexts.get(ctx);
  if (typeof previousDispose === 'function') {
    try {
      previousDispose();
    } catch {
      /* previous instance is best-effort */
    }
    appliedContexts.delete(ctx);
  }

  const state = { instance: null, origin: '', startError: '', closed: false };
  const disposers = [];

  disposers.push(
    ctx.effect(() => {
      const removeRoute = webServer.register({
        kind: 'exact',
        path: ENDPOINT_PATH,
        handler: (req, res) => handleEndpointRoute(req, res, () => ({
          origin: state.closed ? '' : state.origin,
          startError: state.startError,
        })),
      });
      return () => {
        if (typeof removeRoute === 'function') {
          try {
            removeRoute();
          } catch {
            /* already removed */
          }
        }
      };
    }),
  );

  disposers.push(
    ctx.effect(() => {
      const instance = createAnnotatorServer();
      state.instance = instance;
      let disposed = false;
      instance.start().then(
        (info) => {
          if (!disposed) state.origin = info.origin;
        },
        (error) => {
          if (!disposed) state.startError = messageOf(error);
        },
      );
      return async () => {
        disposed = true;
        state.closed = true;
        state.origin = '';
        state.instance = null;
        await instance.close();
      };
    }),
  );

  const dispose = () => {
    state.closed = true;
    state.origin = '';
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      const disposer = disposers[index];
      if (typeof disposer !== 'function') continue;
      try {
        const result = disposer();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        /* best effort */
      }
    }
  };
  appliedContexts.set(ctx, dispose);

  // Acceptance diagnostics: leave a snapshot of how the Loader and the client
  // module registry see this package. Best-effort only; never affects activation.
  try {
    writeStartupDiagnostics(ctx);
    const later = setTimeout(() => writeStartupDiagnostics(ctx), 8000);
    if (typeof later.unref === 'function') later.unref();
  } catch {
    /* diagnostics are optional */
  }
}

const DEBUG_BASENAME = 'dsh-web-annotator-debug';

/**
 * Merge one diagnostics section into the temp report and rewrite it.
 *
 * @param {string} section section key.
 * @param {object} value JSON-safe section value.
 */
function writeDiagnosticsFile(section, value) {
  const payload = (() => {
    let current = {};
    const primary = joinPath(tmpdir(), `${DEBUG_BASENAME}.json`);
    try {
      current = JSON.parse(readFileSync(primary, 'utf8'));
    } catch {
      current = {};
    }
    current.generatedAt = new Date().toISOString();
    current.pid = process.pid;
    current[section] = value;
    return JSON.stringify(current, null, 2);
  })();
  const targets = [joinPath(tmpdir(), `${DEBUG_BASENAME}.json`)];
  if (process.env.USERPROFILE) targets.push(joinPath(process.env.USERPROFILE, `${DEBUG_BASENAME}.json`));
  for (const target of targets) {
    try {
      writeFileSync(target, payload);
    } catch {
      /* diagnostics are optional */
    }
  }
}

/**
 * Collect the Loader row view for this package.
 *
 * @param {*} loader Loader service.
 * @returns {object} diagnostics.
 */
let lastLoaderSnapshot = null;

function collectLoaderDiagnostics(loader) {
  const result = { entries: [], matching: [], access: loader ? 'present' : 'undefined' };
  if (!loader || typeof loader.entries !== 'function') return result;
  let entries = [];
  try {
    entries = loader.entries() || [];
  } catch (error) {
    result.error = messageOf(error);
    return result;
  }
  result.total = entries.length;
  for (const entry of entries) {
    const name = entry && entry.options ? entry.options.name : undefined;
    if (typeof name !== 'string') continue;
    const summary = {
      name,
      id: typeof entry.id === 'string' ? entry.id : null,
      disabled: entry.disabled === true,
      hasFiber: entry.fiber !== undefined,
      baseUrl: entry.parent && entry.parent.tree && entry.parent.tree.ctx ? entry.parent.tree.ctx.baseUrl ?? null : null,
    };
    if (name.includes('annotator')) result.matching.push(summary);
    else result.entries.push(name);
  }
  lastLoaderSnapshot = result;
  return result;
}

/**
 * Collect the composed client-module view for this package.
 *
 * @param {*} modules clientModules service.
 * @returns {object} diagnostics.
 */
function collectClientModulesDiagnostics(modules) {
  const result = { access: modules ? 'present' : 'undefined' };
  if (!modules) return result;
  try {
    const graph = typeof modules.graph === 'function' ? modules.graph() : undefined;
    const ids = graph && Array.isArray(graph.entries) ? graph.entries.map((row) => row && row.id) : null;
    result.graphEntryIds = ids;
    result.hasOurPackage = Array.isArray(ids) && ids.includes('@local/dsh-web-annotator');
  } catch (error) {
    result.graphError = messageOf(error);
  }
  try {
    result.tableKeys = modules.table instanceof Map ? [...modules.table.keys()] : null;
  } catch (error) {
    result.tableError = messageOf(error);
  }
  try {
    const sources = modules.sources instanceof Map ? [...modules.sources.values()] : [];
    result.sources = sources.map((source) => ({
      loaderName: source.loaderName,
      packageName: source.packageName,
      baseUrl: source.baseUrl,
      clientPath: source.meta && source.meta.clientPath,
      inject: source.meta && source.meta.inject,
      immediately: source.meta && source.meta.immediately,
    }));
  } catch (error) {
    result.sourcesError = messageOf(error);
  }
  // Reproduce the composition resolution for this package and record exactly
  // where it stops (locatePkgJson -> manifest -> client export -> bundle file).
  try {
    result.resolveAttempts = [];
    const matching = lastLoaderSnapshot && Array.isArray(lastLoaderSnapshot.matching) ? lastLoaderSnapshot.matching : [];
    for (const entry of matching) {
      const attempt = { name: entry.name, baseUrl: entry.baseUrl };
      try {
        attempt.located = typeof modules.locatePkgJson === 'function' ? modules.locatePkgJson(entry.name, entry.baseUrl) : 'no locatePkgJson';
      } catch (error) {
        attempt.locateError = messageOf(error);
      }
      try {
        attempt.meta = typeof modules.resolveMeta === 'function' ? modules.resolveMeta(entry.name, entry.baseUrl) : 'no resolveMeta';
      } catch (error) {
        attempt.metaError = messageOf(error);
      }
      result.resolveAttempts.push(attempt);
    }
  } catch (error) {
    result.resolveAttemptsError = messageOf(error);
  }
  return result;
}

/**
 * Best-effort diagnostics for client-module activation: direct reads plus
 * optional injected accesses, written to the OS temp directory.
 *
 * @param {*} ctx Cordis plugin context.
 */
function writeStartupDiagnostics(ctx) {
  const access = {};
  const attempt = (label, getter) => {
    try {
      const value = getter();
      access[label] = value === undefined ? 'undefined' : 'present';
      return value;
    } catch (error) {
      access[label] = `error: ${messageOf(error)}`;
      return undefined;
    }
  };
  attempt('get(loader)', () => (typeof ctx.get === 'function' ? ctx.get('loader') : undefined));
  attempt('loader', () => ctx.loader);
  attempt('get(clientModules)', () => (typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined));
  attempt('clientModules', () => ctx.clientModules);
  writeDiagnosticsFile('access', access);
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['loader'], (scope) => {
        writeDiagnosticsFile('loader', collectLoaderDiagnostics(scope.loader));
      });
    } catch (error) {
      writeDiagnosticsFile('loader', { error: messageOf(error) });
    }
    try {
      ctx.inject(['clientModules'], (scope) => {
        writeDiagnosticsFile('clientModules', collectClientModulesDiagnostics(scope.clientModules));
      });
    } catch (error) {
      writeDiagnosticsFile('clientModules', { error: messageOf(error) });
    }
  }
}

/**
 * Handler of `GET /dsh-web-annotator/endpoint` (SPEC.md §2.2).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {() => { origin: string, startError: string }} getState
 */
function handleEndpointRoute(req, res, getState) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(req, res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  let snapshot;
  try {
    snapshot = getState();
  } catch (error) {
    sendJson(req, res, 500, { ok: false, error: messageOf(error) });
    return;
  }

  if (snapshot && snapshot.origin) {
    sendJson(req, res, 200, {
      ok: true,
      proxyOrigin: snapshot.origin,
      runtimePath: RUNTIME_PATH,
      version: PROTOCOL_VERSION,
    });
    return;
  }

  const payload = { ok: false, starting: true };
  if (snapshot && snapshot.startError) payload.error = snapshot.startError;
  sendJson(req, res, 503, payload);
}

// ---------------------------------------------------------------------------
// Small helpers shared by the proxy server
// ---------------------------------------------------------------------------

class BodyTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolve the runtime.js file path override (tests use a temp file). */
function resolveRuntimeFilePath(value) {
  if (value && typeof value === 'object' && typeof value.href === 'string') {
    return new URL(value.href);
  }
  if (typeof value === 'string' && value !== '') return value;
  return new URL('./runtime.js', import.meta.url);
}

/** True when an `If-None-Match` header lists the given strong ETag. */
function etagMatches(headerValue, etag) {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') return false;
  return headerValue
    .split(',')
    .map((token) => token.trim())
    .some((token) => token === '*' || token === etag || token === `W/${etag}`);
}

/** Send a 304 with the given validators and no body (v1.7 runtime.js). */
function sendNotModified(res, headers) {
  try {
    if (typeof res.writeHead === 'function') {
      res.writeHead(304, headers);
    } else {
      if (typeof res.setHeader === 'function') {
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      }
      res.statusCode = 304;
    }
    res.end();
  } catch {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
  }
}

function messageOf(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

function describeFetchFailure(error, timeoutMs) {
  const name = error && typeof error === 'object' ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `target request timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  const cause = error && typeof error === 'object' ? error.cause : undefined;
  const detail =
    (cause && typeof cause === 'object' && (cause.code || cause.message)) ||
    (error && typeof error === 'object' && error.message) ||
    messageOf(error);
  return `target request failed: ${detail}`;
}

function cancelResponseBody(response) {
  try {
    response?.body?.cancel?.();
  } catch {
    /* body already consumed/closed */
  }
}

/** Escape only what could terminate an attribute value; `&` stays raw. */
function escapeHtmlAttribute(value) {
  return String(value ?? '')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Full HTML attribute escaping (including `&`) for the target-URL meta tag. */
function escapeHtmlMetaContent(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function insertAtDocumentFront(document, snippet) {
  const doctypeMatch = /^\s*<!doctype[^>]*>/i.exec(document);
  if (doctypeMatch) {
    const position = doctypeMatch.index + doctypeMatch[0].length;
    return document.slice(0, position) + snippet + document.slice(position);
  }
  return snippet + document;
}

function looksLikeHtml(text) {
  if (typeof text !== 'string' || text === '') return false;
  const head = text.slice(0, 2048).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;
  return /<html[\s>]/.test(head);
}

/**
 * Read a fetch body into a Buffer, aborting as soon as it exceeds `limitBytes`.
 *
 * @param {Response} response
 * @param {number} limitBytes
 * @returns {Promise<Buffer>}
 */
async function readResponseBuffer(response, limitBytes) {
  const declaredLength = Number(
    typeof response?.headers?.get === 'function' ? response.headers.get('content-length') : NaN,
  );
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new BodyTooLargeError(
      `target response exceeds the ${formatByteLimit(limitBytes)} limit`,
    );
  }

  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) {
      throw new BodyTooLargeError(
        `target response exceeds the ${formatByteLimit(limitBytes)} limit`,
      );
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        throw new BodyTooLargeError(
          `target response exceeds the ${formatByteLimit(limitBytes)} limit`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignored */
    }
  }
  return Buffer.concat(chunks, total);
}

function formatByteLimit(limitBytes) {
  if (limitBytes >= 1024 * 1024) return `${Math.round(limitBytes / (1024 * 1024))}MB`;
  if (limitBytes >= 1024) return `${Math.round(limitBytes / 1024)}KB`;
  return `${limitBytes}B`;
}

/**
 * Write a response with the contract's cache headers.
 *
 * @param {import('node:http').IncomingMessage | null} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {string | Buffer} body
 */
function writeResponse(req, res, status, headers, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const finalHeaders = {
    'cache-control': 'no-store',
    ...headers,
    'content-length': String(payload.byteLength),
  };
  try {
    if (typeof res.writeHead === 'function') {
      res.writeHead(status, finalHeaders);
    } else {
      if (typeof res.setHeader === 'function') {
        for (const [name, value] of Object.entries(finalHeaders)) res.setHeader(name, value);
      }
      res.statusCode = status;
    }
    const method = String(req?.method || 'GET').toUpperCase();
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(payload);
    }
  } catch {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage | null} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(req, res, status, payload) {
  let body;
  try {
    body = JSON.stringify(payload ?? {});
  } catch {
    body = '{"ok":false,"error":"serialization failed"}';
  }
  writeResponse(req, res, status, { 'content-type': 'application/json; charset=utf-8' }, body);
}

