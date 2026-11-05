// Performance benchmark for the host half of the web annotator.
// Run: node test/bench.host.mjs      (Node 22, no third-party dependencies)
//
// Measures the paths that matter when opening a page:
//   - GET /asset: same URL requested twice (first vs second) and how often the
//     upstream target server was actually contacted;
//   - GET /proxy: 50 consecutive page loads (document fetch + injection);
//   - GET /runtime.js: first (cold) request and steady-state average;
//   - GET /vendor/html2canvas.min.js: steady-state average.
//
// To give a clean before/after on the same machine and process, the benchmark
// runs two annotator servers side by side:
//   * `before`  — emulates pre-v1.7 behaviour: no /asset caching
//                 (`assetCacheMaxEntryBytes: 1` disables entry caching) and no
//                 runtime.js file read cache (an injected source reader performs
//                 readFileSync on every request, exactly like the old code);
//   * `after`   — the current optimised server (LRU + mtime/size runtime cache).
//
// Prints machine-readable `BENCH key=value` lines plus a human summary.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { createAnnotatorServer } from '../index.js';

const PAGE_HTML =
  '<!doctype html><html><head><title>bench page</title></head>' +
  '<body><main id="app"><p>benchmark page</p></main></body></html>';

const ASSET_BYTES = Buffer.alloc(512 * 1024, 0xab); // 512 KB: cacheable (<4MB)
const ASSET_ROUNDS = 5;
const PROXY_REQUESTS = 50;
const RUNTIME_REQUESTS = 30;
const VENDOR_REQUESTS = 20;

const RUNTIME_FILE_URL = new URL('../runtime.js', import.meta.url);

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

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function report(key, value) {
  console.log(`BENCH ${key}=${typeof value === 'number' ? round(value) : value}`);
}

async function timed(fn) {
  const started = performance.now();
  const result = await fn();
  return { ms: performance.now() - started, result };
}

async function fetchBytes(url, headers) {
  const response = await fetch(url, { headers });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    etag: response.headers.get('etag') || '',
    body: Buffer.from(await response.arrayBuffer()),
  };
}

/**
 * Measure first/second request timings + upstream hits for one proxy server.
 * `label` keeps the upstream URLs of the before/after runs distinct so the hit
 * counters stay independent.
 * @returns {Promise<{ firstAvgMs: number, secondAvgMs: number, upstreamPerUrl: number[], bytes: number[] }>}
 */
async function measureAsset(proxyOrigin, targetOrigin, upstreamHits, label) {
  const first = [];
  const second = [];
  const upstreamPerUrl = [];
  const bytes = [];
  for (let roundIndex = 0; roundIndex < ASSET_ROUNDS; roundIndex += 1) {
    const targetAssetUrl = `${targetOrigin}/asset-heavy?${label}=${roundIndex}`;
    const upstreamKey = `/asset-heavy?${label}=${roundIndex}`;
    const proxyAssetUrl = `${proxyOrigin}/asset?url=${encodeURIComponent(targetAssetUrl)}`;
    const firstRun = await timed(async () => {
      const fetched = await fetchBytes(proxyAssetUrl);
      if (fetched.status !== 200 || fetched.body.length !== ASSET_BYTES.length) {
        throw new Error(`unexpected asset response: ${fetched.status} ${fetched.body.length}`);
      }
      return fetched.body.length;
    });
    const secondRun = await timed(async () => {
      const fetched = await fetchBytes(proxyAssetUrl);
      if (fetched.status !== 200 || fetched.body.length !== ASSET_BYTES.length) {
        throw new Error(`unexpected second asset response: ${fetched.status} ${fetched.body.length}`);
      }
      return fetched.body.length;
    });
    first.push(firstRun.ms);
    second.push(secondRun.ms);
    bytes.push(secondRun.result);
    upstreamPerUrl.push(upstreamHits.get(upstreamKey) || 0);
  }
  return {
    firstAvgMs: average(first),
    secondAvgMs: average(second),
    upstreamPerUrl,
    bytes,
  };
}

async function measureSteady(url, rounds, validate) {
  const times = [];
  for (let index = 0; index < rounds; index += 1) {
    const run = await timed(async () => {
      const response = await fetch(url);
      const text = await response.text();
      if (!validate(response.status, text)) {
        throw new Error(`unexpected response: ${response.status}`);
      }
    });
    times.push(run.ms);
  }
  return { avgMs: average(times), medianMs: median(times), times };
}

async function main() {
  const upstreamHits = new Map();
  const bump = (key) => {
    const next = (upstreamHits.get(key) || 0) + 1;
    upstreamHits.set(key, next);
    return next;
  };

  const target = http.createServer((req, res) => {
    let pathname = '/';
    let search = '';
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      pathname = url.pathname;
      search = url.search;
    } catch {
      /* keep defaults */
    }
    bump(pathname + search);
    if (pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (pathname === '/asset-heavy') {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(ASSET_BYTES.length),
      });
      res.end(ASSET_BYTES);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const targetPort = await listenServer(target);
  const targetOrigin = `http://127.0.0.1:${targetPort}`;

  // `after`: current optimised behaviour (defaults).
  const afterProxy = createAnnotatorServer();
  const afterInfo = await afterProxy.start();
  // `before`: emulates pre-v1.7 /asset (no caching) and runtime.js (read every
  // request through an injected reader) behaviour on the same machine.
  const beforeProxy = createAnnotatorServer({
    assetCacheMaxEntryBytes: 1,
    runtimeSource: () => readFileSync(RUNTIME_FILE_URL, 'utf8'),
  });
  const beforeInfo = await beforeProxy.start();

  const afterOrigin = afterInfo.origin;
  const beforeOrigin = beforeInfo.origin;

  try {
    // Warm up connection pools so connect time does not dominate.
    await fetch(afterOrigin + '/health').then((response) => response.text());
    await fetch(beforeOrigin + '/health').then((response) => response.text());

    // --- GET /asset: before (no cache) vs after (LRU) --------------------
    const beforeAsset = await measureAsset(beforeOrigin, targetOrigin, upstreamHits, 'before');
    const afterAsset = await measureAsset(afterOrigin, targetOrigin, upstreamHits, 'after');

    // --- GET /proxy: 50 consecutive page loads (unchanged by v1.7) -------
    const proxyUrl = `${afterOrigin}/proxy?url=${encodeURIComponent(targetOrigin + '/page')}`;
    for (let warmup = 0; warmup < 3; warmup += 1) {
      await fetch(proxyUrl).then((response) => response.text());
    }
    const proxyTimes = [];
    const proxyStarted = performance.now();
    for (let index = 0; index < PROXY_REQUESTS; index += 1) {
      const run = await timed(async () => {
        const response = await fetch(proxyUrl);
        const text = await response.text();
        if (response.status !== 200 || !text.includes('<base href=')) {
          throw new Error(`unexpected /proxy response: ${response.status}`);
        }
      });
      proxyTimes.push(run.ms);
    }
    const proxyTotalMs = performance.now() - proxyStarted;

    // --- GET /runtime.js: before (read each time) vs after (mtime cache) -
    const beforeRuntimeCold = await timed(async () => {
      const fetched = await fetchBytes(beforeOrigin + '/runtime.js');
      if (fetched.status !== 200 || fetched.body.length < 1000) {
        throw new Error(`unexpected /runtime.js response: ${fetched.status}`);
      }
      return fetched.body.length;
    });
    const beforeRuntimeSteady = await measureSteady(
      beforeOrigin + '/runtime.js',
      RUNTIME_REQUESTS,
      (status) => status === 200,
    );
    const afterRuntimeCold = await timed(async () => {
      const fetched = await fetchBytes(afterOrigin + '/runtime.js');
      if (fetched.status !== 200 || fetched.body.length < 1000) {
        throw new Error(`unexpected /runtime.js response: ${fetched.status}`);
      }
      return fetched.body.length;
    });
    const afterRuntimeSteady = await measureSteady(
      afterOrigin + '/runtime.js',
      RUNTIME_REQUESTS,
      (status) => status === 200,
    );

    // --- GET /vendor/html2canvas.min.js: steady state --------------------
    const vendorSteady = await measureSteady(
      afterOrigin + '/vendor/html2canvas.min.js',
      VENDOR_REQUESTS,
      (status, text) => status === 200 && text.length > 100000,
    );

    const summary = {
      assetBeforeFirstAvgMs: beforeAsset.firstAvgMs,
      assetBeforeSecondAvgMs: beforeAsset.secondAvgMs,
      assetBeforeUpstreamPerUrl: beforeAsset.upstreamPerUrl,
      assetAfterFirstAvgMs: afterAsset.firstAvgMs,
      assetAfterSecondAvgMs: afterAsset.secondAvgMs,
      assetAfterUpstreamPerUrl: afterAsset.upstreamPerUrl,
      assetHitSpeedup: afterAsset.secondAvgMs === 0 ? 0 : beforeAsset.secondAvgMs / afterAsset.secondAvgMs,
      proxy50AvgMs: average(proxyTimes),
      proxy50MedianMs: median(proxyTimes),
      proxy50TotalMs: proxyTotalMs,
      runtimeBeforeColdMs: beforeRuntimeCold.ms,
      runtimeBeforeAvgMs: beforeRuntimeSteady.avgMs,
      runtimeBeforeMedianMs: beforeRuntimeSteady.medianMs,
      runtimeBeforeBytes: beforeRuntimeCold.result,
      runtimeAfterColdMs: afterRuntimeCold.ms,
      runtimeAfterAvgMs: afterRuntimeSteady.avgMs,
      runtimeAfterMedianMs: afterRuntimeSteady.medianMs,
      runtimeAfterBytes: afterRuntimeCold.result,
      runtimeSpeedup:
        afterRuntimeSteady.avgMs === 0 ? 0 : beforeRuntimeSteady.avgMs / afterRuntimeSteady.avgMs,
      vendorAvgMs: vendorSteady.avgMs,
    };

    report('asset_before_first_ms_avg', summary.assetBeforeFirstAvgMs);
    report('asset_before_second_ms_avg', summary.assetBeforeSecondAvgMs);
    report('asset_before_upstream_per_url', summary.assetBeforeUpstreamPerUrl.join(','));
    report('asset_after_first_ms_avg', summary.assetAfterFirstAvgMs);
    report('asset_after_second_ms_avg', summary.assetAfterSecondAvgMs);
    report('asset_after_upstream_per_url', summary.assetAfterUpstreamPerUrl.join(','));
    report('asset_hit_speedup_x', summary.assetHitSpeedup);
    report('proxy_50_avg_ms', summary.proxy50AvgMs);
    report('proxy_50_median_ms', summary.proxy50MedianMs);
    report('runtime_before_cold_ms', summary.runtimeBeforeColdMs);
    report('runtime_before_avg_ms', summary.runtimeBeforeAvgMs);
    report('runtime_before_median_ms', summary.runtimeBeforeMedianMs);
    report('runtime_after_cold_ms', summary.runtimeAfterColdMs);
    report('runtime_after_avg_ms', summary.runtimeAfterAvgMs);
    report('runtime_after_median_ms', summary.runtimeAfterMedianMs);
    report('runtime_speedup_x', summary.runtimeSpeedup);
    report('runtime_bytes', summary.runtimeAfterBytes);
    report('vendor_avg_ms', summary.vendorAvgMs);
    console.log('BENCH json=' + JSON.stringify(summary));

    console.log('');
    console.log('host benchmark (ms):');
    console.log(
      `  /asset  before: 1st ${round(summary.assetBeforeFirstAvgMs)}, 2nd ${round(
        summary.assetBeforeSecondAvgMs,
      )} (upstream hits ${summary.assetBeforeUpstreamPerUrl.join(',')})`,
    );
    console.log(
      `  /asset  after : 1st ${round(summary.assetAfterFirstAvgMs)}, 2nd ${round(
        summary.assetAfterSecondAvgMs,
      )} (upstream hits ${summary.assetAfterUpstreamPerUrl.join(',')}, hit speedup x${round(
        summary.assetHitSpeedup,
      )})`,
    );
    console.log(
      `  /proxy  50 requests: avg ${round(summary.proxy50AvgMs)}, median ${round(
        summary.proxy50MedianMs,
      )}, total ${round(summary.proxy50TotalMs)}`,
    );
    console.log(
      `  /runtime.js before: cold ${round(summary.runtimeBeforeColdMs)}, steady avg ${round(
        summary.runtimeBeforeAvgMs,
      )}, median ${round(summary.runtimeBeforeMedianMs)}`,
    );
    console.log(
      `  /runtime.js after : cold ${round(summary.runtimeAfterColdMs)}, steady avg ${round(
        summary.runtimeAfterAvgMs,
      )}, median ${round(summary.runtimeAfterMedianMs)} (x${round(summary.runtimeSpeedup)})`,
    );
    console.log(`  /vendor steady avg ${round(summary.vendorAvgMs)}`);
  } finally {
    await closeServer(afterProxy);
    await closeServer(beforeProxy);
    await closeServer(target);
  }
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    console.error('bench failed:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  },
);
