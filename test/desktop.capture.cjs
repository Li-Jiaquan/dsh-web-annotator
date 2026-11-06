// Run with Electron 44: electron test/desktop.capture.cjs
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const project = path.join(__dirname, '..');
const profile = mkdtempSync(path.join(tmpdir(), 'dsha-native-profile-'));
app.setPath('userData', profile);

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

async function run() {
  const { createAnnotatorServer } = await import('../index.js');
  const target = await listen((req, res) => {
    if (req.url === '/blue.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="rgb(40,120,240)"/></svg>');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body style="margin:0;height:2000px"><img src="${target.url}/blue.svg" style="position:absolute;left:140px;top:120px;width:100px;height:60px"></body>`);
  });
  let vendorHits = 0;
  let assetHits = 0;
  const proxy = createAnnotatorServer({
    async fetchImpl(url, options) {
      if (new URL(url).pathname === '/blue.svg') {
        assetHits += 1;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      return fetch(url, options);
    },
    vendorSource() {
      vendorHits += 1;
      return readFileSync(path.join(project, 'vendor', 'html2canvas.min.js'));
    },
  });
  const { origin } = await proxy.start();
  const url = `${origin}/proxy?url=${encodeURIComponent(target.url)}`;
  const client = readFileSync(path.join(project, 'client.js'), 'utf8');
  const desktop = client.split('/* dsha:desktopGuest-begin */')[1].split('/* dsha:desktopGuest-end */')[0];
  const lease = randomUUID();
  const partition = 'dsha-test-' + lease;
  const embedder = await listen((req, res) => {
    if (req.url === '/counts') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ vendorHits, assetHits }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><div id="container" style="width:500px;height:400px"></div>
      <style>.dsha-frame {display:flex;width:100%;height:100%}</style><script>
      const CHANNEL = 'dsh-web-annotator';
      const PAGE_TO_PARENT = ['ready', 'mode', 'screenshots'];
      const NOOP_INBOUND_TYPES = new Set();
      const NATIVE_CAPTURE_TIMEOUT_MS = 750;
      const PAGE_SCREENSHOT_ID = '__page__';
      ${desktop}
      window.result = new Promise((resolve, reject) => {
        let step = 0;
        let legacyStarted = 0;
        const preview = mountDesktopGuest(document.getElementById('container'), {
          acquire: async () => (${JSON.stringify({ lease, partition })}),
          release: async () => {},
        }, {
          load() { post('hello'); },
          unavailable(error) { reject(new Error('guest unavailable: ' + error)); },
          error() { reject(new Error('guest load failed')); },
          async message(data) {
            try {
              if (data.type === 'ready' && step === 0) {
                step = 1;
                setAnnotation(120);
              } else if (data.type === 'mode' && data.payload.active && step === 1) {
                step = 2;
                const started = performance.now();
                const item = await preview.capture(['mark'], 'native');
                const duration = performance.now() - started;
                if (!item) {
                  const guest = document.querySelector('webview');
                  const size = await guest.executeJavaScript('({ dpr: devicePixelRatio, viewport: [innerWidth, innerHeight] })');
                  throw new Error('native capture returned no image: ' + JSON.stringify({ duration, zoom: guest.getZoomFactor(), size }));
                }
                const image = new Image();
                image.src = item.dataUrl;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(image, 0, 0);
                const pixel = (x, y) => Array.from(ctx.getImageData(
                  Math.floor(x * canvas.width / 196), Math.floor(y * canvas.height / 156), 1, 1,
                ).data);
                const counts = await fetch('/counts').then((res) => res.json());
                window.snapshot = { id: item.id, size: [canvas.width, canvas.height], center: pixel(98, 78), outline: pixel(48, 78), badge: pixel(54, 54), duration, counts };
                legacyStarted = performance.now();
                preview.post({ channel: CHANNEL, type: 'capture-screenshots', requestId: 'legacy', ids: ['mark'], options: { mode: 'area' } });
              } else if (data.type === 'screenshots' && data.requestId === 'legacy' && step === 2) {
                if (data.items?.[0]?.id !== '__page__') throw new Error('legacy capture returned no image');
                step = 3;
                window.snapshot.legacyDuration = performance.now() - legacyStarted;
                setAnnotation(1700);
              } else if (data.type === 'mode' && data.payload.active && step === 3) {
                step = 4;
                const offscreen = await preview.capture(['mark'], 'offscreen');
                preview.dispose();
                resolve({ ...window.snapshot, offscreen });
              }
            } catch (error) {
              reject(error);
            }
          },
        });
        function post(type, payload) { preview.post({ channel: CHANNEL, type, payload }); }
        function setAnnotation(y) {
          post('set-annotations', { annotations: [{ id: 'mark', kind: 'region', number: 7, rect: { x: 140, y, width: 100, height: 60 } }] });
          post('set-mode', { active: true });
        }
        preview.navigate(${JSON.stringify(url)});
      });
      </script>`);
  });
  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 500,
    webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    if (params.src !== 'about:blank#' + lease || params.partition !== partition) event.preventDefault();
    Object.assign(preferences, { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false });
  });

  try {
    await window.loadURL(embedder.url);
    const result = await window.webContents.executeJavaScript('window.result');
    assert.equal(result.id, '__page__');
    const [width, height] = result.size;
    assert.ok(width >= 196 && height >= 156 && Math.abs(width / 196 - height / 156) < 0.01, JSON.stringify(result));
    assert.ok(result.center[2] > 200 && result.center[0] < 80, JSON.stringify(result));
    assert.deepEqual(result.outline.slice(0, 3), [225, 29, 72]);
    assert.deepEqual(result.badge.slice(0, 3), [159, 18, 57]);
    assert.equal(result.offscreen, null);
    assert.deepEqual(result.counts, { vendorHits: 0, assetHits: 0 });
    assert.equal(vendorHits, 1, 'legacy capture loads its renderer');
    assert.equal(assetHits, 1, 'legacy capture refetches the cross-origin image');
    console.log(`PASS native clip, marks and offscreen fallback. Native ${result.duration.toFixed(1)} ms, legacy ${result.legacyDuration.toFixed(1)} ms`);
  } finally {
    window.destroy();
    embedder.server.closeAllConnections();
    embedder.server.close();
    await proxy.close();
    target.server.closeAllConnections();
    target.server.close();
  }
}

const timeout = setTimeout(() => { console.error('Native capture test timed out'); app.exit(1); }, 20000);
app.whenReady().then(run).then(() => {
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
