/**
 * Photopea render service (async job pattern, URL-hash config).
 *
 * POST /render  → 202 { job_id } immediately (bypasses Railway gateway timeout)
 * GET  /status/:job_id → { status, result(base64), error, contentType }
 *
 * Loads Photopea in an IFRAME (the documented OE model: Photopea posts to
 * window.parent). The iframe src uses Photopea's URL hash config
 * {"files":[psd],"script":...} so Photopea auto-loads the PSD and runs the
 * replacement + saveToOE script with no "done" handshake and no postMessage
 * scripting from Node.
 */
const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '256mb' }));

const PORT = process.env.PORT || 3000;
const JOB_TTL_MS = 10 * 60 * 1000;

let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 300000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--enable-wasm',
      ],
    });
  }
  return browser;
}

const jobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.startedAt < cutoff) jobs.delete(id);
}, 60 * 1000).unref?.();

function newJobId() {
  return crypto.randomBytes(9).toString('base64url');
}

app.post('/render', (req, res) => {
  const { psd_url, output_format = 'jpg', replacements = [] } = req.body || {};
  if (!psd_url) return res.status(400).json({ error: 'psd_url is required' });

  const jobId = newJobId();
  jobs.set(jobId, { status: 'pending', result: null, error: null, contentType: null, startedAt: Date.now() });

  processRender(jobId, { psd_url, output_format, replacements });

  return res.status(202).json({ job_id: jobId });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  return res.json(job);
});

app.get('/health', (req, res) => res.json({ ok: true }));

function buildReplacementScript(replacements, output_format) {
  return [
    'var replacements = ' + JSON.stringify(replacements) + ';',
    'var doc = app.activeDocument;',
    'function walk(layers) {',
    '  for (var i = 0; i < layers.length; i++) {',
    '    var l = layers[i];',
    '    if (l.children && l.children.length) { walk(l.children); continue; }',
    '    for (var k = 0; k < replacements.length; k++) {',
    '      var rep = replacements[k];',
    '      if (l.name !== rep.layer_name) continue;',
    '      if (rep.type === "text") { try {',
    '        if (l.textItem) { l.textItem.contents = rep.text; }',
    '        else if (l.text) { l.text.text = rep.text; }',
    '      } catch (e) {} }',
    '      else if (rep.type === "artwork") { try { replaceArtworkLayer(l, rep.image_url); } catch (e) {} }',
    '    }',
    '  }',
    '}',
    'function replaceArtworkLayer(layer, imageUrl) {',
    '  var ob = layer.bounds;',
    '  var ow = ob[2] - ob[0], oh = ob[3] - ob[1];',
    '  var name = layer.name;',
    '  layer.remove();',
    '  app.open(imageUrl, undefined, true);',
    '  var nl = app.activeDocument.activeLayer;',
    '  if (!nl) return;',
    '  var nb = nl.bounds;',
    '  var nw = nb[2] - nb[0], nh = nb[3] - nb[1];',
    '  if (nw > 0 && nh > 0) {',
    '    var scale = Math.min(ow / nw, oh / nh) * 100;',
    '    if (scale > 0) nl.resize(scale, scale);',
    '  }',
    '  var cb = nl.bounds;',
    '  nl.translate(ob[0] - cb[0], ob[1] - cb[1]);',
    '  nl.name = name;',
    '}',
    'walk(doc.layers);',
    'app.echoToOE("script_done");',
    'app.activeDocument.saveToOE(' + JSON.stringify(output_format) + ');'
  ].join('\n');
}

async function processRender(jobId, params) {
  const { psd_url, output_format, replacements } = params;
  const contentType = output_format === 'png' ? 'image/png' : 'image/jpeg';
  let page;
  try {
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing' });

    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', (msg) => console.log(`[${jobId}] [${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[${jobId}] [pageerror] ${err.message}`));

    // Build the replacement script (runs inside Photopea after PSD loads).
    const script = buildReplacementScript(replacements, output_format);

    // Load a blank shell, then create a Photopea iframe (no hash config).
    // Drive Photopea via postMessage: wait for "done", open PSD, run script,
    // then saveToOE posts the ArrayBuffer to window.parent (this shell).
    await page.setContent('<!DOCTYPE html><html><body style="margin:0"></body></html>', { waitUntil: 'load' });
    console.log(`[${jobId}] creating Photopea iframe (${replacements.length} replacement(s))`);

    const b64 = await page.evaluate(async (psdUrl, fmt, replacementScript) => {
      const iframe = document.createElement('iframe');
      iframe.src = 'https://www.photopea.com';
      iframe.style.cssText = 'width:100%;height:100vh;border:0;';
      document.body.appendChild(iframe);
      const pp = iframe.contentWindow;

      const messages = [];
      window.addEventListener('message', (e) => {
        if (typeof e.data === 'string') messages.push(e.data);
      });

      const waitFor = (target, timeoutMs = 120000) => new Promise((resolve, reject) => {
        if (messages.includes(target)) return resolve();
        const to = setTimeout(() => {
          cleanup();
          reject(new Error('Timeout waiting for: ' + target + ' | seen: ' + messages.slice(-20).join(', ')));
        }, timeoutMs);
        const h = (e) => { if (e.data === target) { cleanup(); resolve(); } };
        const cleanup = () => { clearTimeout(to); window.removeEventListener('message', h); };
        window.addEventListener('message', h);
      });

      // 1. Wait for Photopea to signal it's ready
      await waitFor('done');
      // 2. Load the PSD
      pp.postMessage('app.open(' + JSON.stringify(psdUrl) + '); app.echoToOE("psd_loaded");', '*');
      await waitFor('psd_loaded');
      // 3. Run the replacement script
      pp.postMessage(replacementScript, '*');
      await waitFor('script_done');
      // 4. Export and capture the ArrayBuffer
      const arrayBuffer = await new Promise((resolve, reject) => {
        const to = setTimeout(() => { cleanup(); reject(new Error('Export timeout — no ArrayBuffer. Messages: ' + messages.slice(-20).join(', '))); }, 120000);
        const h = (e) => { if (e.data instanceof ArrayBuffer) { cleanup(); resolve(e.data); } };
        const cleanup = () => { clearTimeout(to); window.removeEventListener('message', h); };
        window.addEventListener('message', h);
        pp.postMessage('app.activeDocument.saveToOE(' + JSON.stringify(fmt) + ');', '*');
      });
      // 5. Convert to base64
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1]);
        fr.readAsDataURL(new Blob([arrayBuffer]));
      });
    }, psd_url, output_format, script);

    if (!b64) throw new Error('No output returned from Photopea');

    jobs.set(jobId, { status: 'complete', result: b64, error: null, contentType, startedAt: jobs.get(jobId).startedAt });
    console.log(`[${jobId}] complete (${b64.length} b64 chars)`);
  } catch (err) {
    console.error(`[${jobId}] render failed:`, err.message);
    let diag = err.message;
    if (page) {
      diag += ' | url: ' + await page.evaluate(() => window.location.href).catch(() => 'n/a');
    }
    jobs.set(jobId, { status: 'error', result: null, error: diag, contentType: null, startedAt: jobs.get(jobId).startedAt });
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

app.listen(PORT, () => console.log(`Photopea render service listening on :${PORT}`));
