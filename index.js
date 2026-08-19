/**
 * Photopea render service (async job pattern, direct navigation).
 *
 * POST /render  → 202 { job_id } immediately (bypasses Railway gateway timeout)
 * GET  /status/:job_id → { status, result(base64), error, contentType }
 *
 * The render navigates headless Chrome DIRECTLY to photopea.com (no iframe),
 * which is more reliable than embedding — Photopea's WASM editor initializes
 * properly as the top page and posts its "done" ready signal.
 */
const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '256mb' }));

const PORT = process.env.PORT || 3000;
const JOB_TTL_MS = 10 * 60 * 1000;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
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

const RENDER_FN = async (params) => {
  const { psd_url, output_format, replacements } = params;
  const win = window;

  // Global message buffer — captures every postMessage from Photopea.
  win.__ppSeen = new Set();
  win.__ppMessages = [];
  win.addEventListener('message', (e) => {
    const key = (typeof e.data === 'string')
      ? e.data
      : (e.data instanceof ArrayBuffer ? '__ab__' : JSON.stringify(e.data));
    if (!win.__ppSeen.has(key)) { win.__ppSeen.add(key); win.__ppMessages.push(key); }
  });

  const waitFor = (target, timeoutMs = 100000) => new Promise((resolve, reject) => {
    if (win.__ppSeen.has(target)) return resolve();
    const to = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for: ' + target + ' | seen: ' + win.__ppMessages.slice(-16).join(', ')));
    }, timeoutMs);
    const h = (e) => { if (e.data === target) { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(to); win.removeEventListener('message', h); };
    win.addEventListener('message', h);
  });

  // 1. Wait for Photopea ready
  await waitFor('done');

  // 2. Load the PSD
  win.postMessage('app.open(' + JSON.stringify(psd_url) + '); app.echoToOE("psd_loaded");', '*');
  await waitFor('psd_loaded');

  // 3. Apply layer replacements
  win.postMessage(buildReplacementScript(replacements), '*');
  await waitFor('replaced');

  // 4. Export and capture the ArrayBuffer
  const arrayBuffer = await new Promise((resolve, reject) => {
    const to = setTimeout(() => { cleanup(); reject(new Error('Export timeout')); }, 100000);
    const h = (e) => { if (e.data instanceof ArrayBuffer) { cleanup(); resolve(e.data); } };
    const cleanup = () => { clearTimeout(to); win.removeEventListener('message', h); };
    win.addEventListener('message', h);
    win.postMessage('app.activeDocument.saveToOE(' + JSON.stringify(output_format) + ');', '*');
  });

  // 5. base64 for transport
  const b64 = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.readAsDataURL(new Blob([arrayBuffer]));
  });
  return b64;
};

function buildReplacementScript(replacements) {
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
    'app.echoToOE("replaced");'
  ].join('\n');
}

async function processRender(jobId, params) {
  const contentType = params.output_format === 'png' ? 'image/png' : 'image/jpeg';
  let page;
  try {
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing' });

    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', (msg) => console.log(`[${jobId}] [${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[${jobId}] [pageerror] ${err.message}`));

    console.log(`[${jobId}] navigating to photopea.com`);
    await page.goto('https://www.photopea.com', { waitUntil: 'load', timeout: 90000 });

    const b64 = await page.evaluate(RENDER_FN, params);
    if (!b64) throw new Error('No output returned from Photopea');

    jobs.set(jobId, { status: 'complete', result: b64, error: null, contentType, startedAt: jobs.get(jobId).startedAt });
    console.log(`[${jobId}] complete (${b64.length} b64 chars)`);
  } catch (err) {
    console.error(`[${jobId}] render failed:`, err.message);
    let diag = err.message;
    if (page) {
      diag += ' | seen: ' + await page.evaluate(() => (window.__ppMessages || []).slice(-20).join(', ')).catch(() => 'n/a');
      diag += ' | url: ' + await page.evaluate(() => window.location.href).catch(() => 'n/a');
    }
    jobs.set(jobId, { status: 'error', result: null, error: diag, contentType: null, startedAt: jobs.get(jobId).startedAt });
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

app.listen(PORT, () => console.log(`Photopea render service listening on :${PORT}`));
