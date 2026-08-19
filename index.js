/**
 * PSD Render Service (Photopea Headless)
 *
 * Architecture: Base44 → this API → rendered PNG/JPEG
 *
 * Uses headless Chrome + Photopea iframe to perform NATIVE PSD operations:
 *   - Smart Object contents replacement (via placedLayerEditContents + app.open)
 *   - Text layer editing (via textItem.contents)
 *   - Full composite export (preserving transforms, warps, masks, effects)
 *
 * Photopea messaging protocol:
 *   - OE sends String (script) or ArrayBuffer (binary file) via postMessage
 *   - Photopea sends "done" after processing each message
 *   - app.echoToOE(string) sends a string back to OE
 *   - app.activeDocument.saveToOE(format) sends an ArrayBuffer back to OE
 *
 * API:
 *   POST /render  → 202 { job_id }
 *   GET  /status/:job_id → { status, result(base64), error, contentType, matchLog }
 *   POST /layers → { width, height, layers[] }  (ag-psd inspection only)
 *   GET  /health → { ok: true, engine: 'photopea-headless' }
 */
const express = require('express');
const puppeteer = require('puppeteer');
const { readPsd } = require('ag-psd');
const crypto = require('crypto');

// ── App setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256mb' }));

const PORT = process.env.PORT || 8080;
const JOB_TTL_MS = 10 * 60 * 1000;
const jobs = new Map();

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.startedAt < cutoff) jobs.delete(id);
}, 60 * 1000).unref?.();

function newJobId() { return crypto.randomBytes(9).toString('base64url'); }

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, engine: 'photopea-headless' }));

// Local HTML page that embeds Photopea in an iframe.
// Served from http://localhost:PORT so the parent page has a real HTTP origin
// (not about:blank) — this gives both parent and iframe full localStorage access.
app.get('/pe-frame', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html><head><title>Photopea Render</title></head>
<body style="margin:0;padding:0;overflow:hidden;">
  <iframe id="pe" src="https://www.photopea.com" style="width:100%;height:100vh;border:none;"></iframe>
  <script>
    window.__msgQueue = [];
    window.addEventListener('message', function(e) {
      window.__msgQueue.push(e.data);
    });
  </script>
</body></html>`);
});

// ag-psd inspection endpoint — lists all layer names, types, and bounds
app.post('/layers', async (req, res) => {
  try {
    const { psd_url } = req.body || {};
    if (!psd_url) return res.status(400).json({ error: 'psd_url is required' });

    const psdRes = await fetch(psd_url);
    if (!psdRes.ok) return res.status(400).json({ error: `PSD download failed (${psdRes.status})` });
    const psdBuffer = Buffer.from(await psdRes.arrayBuffer());
    const psd = readPsd(psdBuffer, { skipLayerImageData: true });

    const layers = [];
    function walk(ls, depth) {
      if (!ls) return;
      for (const layer of ls) {
        const w = (layer.right || 0) - (layer.left || 0);
        const h = (layer.bottom || 0) - (layer.top || 0);
        layers.push({
          name: layer.name,
          depth,
          type: layer.text ? 'text' : layer.children ? 'group' : layer.smartObject ? 'smart_object' : 'pixel',
          hidden: !!layer.hidden,
          bounds: w > 0 && h > 0 ? { w, h, left: layer.left, top: layer.top } : null,
        });
        if (layer.children) walk(layer.children, depth + 1);
      }
    }
    walk(psd.children || [], 0);
    return res.json({ width: psd.width, height: psd.height, layers });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/render', (req, res) => {
  const { psd_url, output_format = 'jpg', replacements = [] } = req.body || {};
  if (!psd_url) return res.status(400).json({ error: 'psd_url is required' });

  const jobId = newJobId();
  jobs.set(jobId, { status: 'pending', result: null, error: null, contentType: null, startedAt: Date.now() });

  processRender(jobId, { psd_url, output_format, replacements }).catch((err) => {
    jobs.set(jobId, { ...jobs.get(jobId), status: 'error', error: err.message || 'Unknown error' });
  });

  return res.status(202).json({ job_id: jobId });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  return res.json(job);
});

// ── Photopea rendering ──────────────────────────────────────────────────────

async function processRender(jobId, { psd_url, output_format, replacements }) {
  const contentType = output_format === 'png' ? 'image/png' : 'image/jpeg';
  jobs.set(jobId, { ...jobs.get(jobId), status: 'processing' });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Capture page console and errors for debugging
    page.on('console', msg => console.log(`[${jobId}] [page console] ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', err => console.log(`[${jobId}] [page error] ${err.message}`));

    // Load the local /pe-frame page which embeds Photopea in an iframe.
    // Photopea only activates its OE messaging API when it detects it's
    // inside an iframe (parent !== window). The local HTTP origin (not
    // about:blank) ensures both parent and iframe have localStorage access.
    console.log(`[${jobId}] Loading Photopea iframe…`);
    await page.goto(`http://localhost:${PORT}/pe-frame`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#pe', { timeout: 10000 });

    // Wait for Photopea to initialize — it sends "done" when ready.
    console.log(`[${jobId}] Waiting for Photopea to initialize…`);
    await waitForMessage(page, 'done', 180000);
    console.log(`[${jobId}] Photopea ready`);

    // 1. Open the PSD from URL
    console.log(`[${jobId}] Opening PSD: ${psd_url.substring(0, 80)}…`);
    await runScript(page, `app.open("${esc(psd_url)}");`, 180000);
    await new Promise(r => setTimeout(r, 3000));

    const matchLog = [];

    // 2. Process replacements
    for (const rep of replacements) {
      if (rep.type === 'text') {
        console.log(`[${jobId}] Text: ${rep.layer_name} → "${rep.text}"`);
        const result = await runScript(page, `
          var l = app.activeDocument.layers.getByName("${esc(rep.layer_name)}");
          app.activeDocument.activeLayer = l;
          if (l.textItem) {
            l.textItem.contents = "${esc(rep.text)}";
            app.echoToOE("TEXT_SET");
          } else {
            app.echoToOE("NOT_TEXT_LAYER");
          }
        `);
        matchLog.push({ rep: rep.layer_name, type: 'text', result });

      } else if (rep.type === 'artwork' || rep.type === 'smart_object') {
        console.log(`[${jobId}] Smart Object: ${rep.layer_name}`);

        // Step a: Open the smart object for editing
        const openResult = await runScript(page, `
          var l = app.activeDocument.layers.getByName("${esc(rep.layer_name)}");
          app.activeDocument.activeLayer = l;
          executeAction(stringIDToTypeID("placedLayerEditContents"));
          app.echoToOE("SO_OPENED:" + app.activeDocument.width + "x" + app.activeDocument.height);
        `);

        if (openResult && openResult.length > 0 && openResult[0].startsWith('SO_OPENED')) {
          matchLog.push({ rep: rep.layer_name, type: 'so_open', result: openResult[0] });
          const soDims = openResult[0].substring('SO_OPENED:'.length);

          // Step b: Clear SO content, load artwork into SO document
          await runScript(page, `
            var soDoc = app.activeDocument;
            soDoc.flatten();
            soDoc.selection.selectAll();
            soDoc.selection.clear();
            app.open("${esc(rep.image_url)}", null, true);
            app.echoToOE("ARTWORK_LOADED");
          `, 180000);
          await new Promise(r => setTimeout(r, 3000));

          // Step c: Position artwork to fill SO canvas, merge, save, close
          const replaceResult = await runScript(page, `
            var soDoc = app.activeDocument;
            var pastedLayer = soDoc.activeLayer;

            var bounds = pastedLayer.bounds;
            var artW = bounds[2] - bounds[0];
            var artH = bounds[3] - bounds[1];
            var soW = soDoc.width;
            var soH = soDoc.height;

            var scale = Math.min(soW / artW, soH / artH) * 100;
            pastedLayer.resize(scale, scale);

            bounds = pastedLayer.bounds;
            var newW = bounds[2] - bounds[0];
            var newH = bounds[3] - bounds[1];
            var offsetX = (soW - newW) / 2 - bounds[0];
            var offsetY = (soH - newH) / 2 - bounds[1];
            pastedLayer.translate(offsetX, offsetY);

            pastedLayer.merge();
            soDoc.save();
            soDoc.close();
            app.echoToOE("SO_REPLACED:" + soDims);
          `, 120000);
          matchLog.push({ rep: rep.layer_name, type: 'so_replace', result: replaceResult[0] || 'no_result' });
        } else {
          matchLog.push({ rep: rep.layer_name, type: 'so_open', result: 'FAILED', detail: openResult });
        }
      }
    }

    // 3. Export
    console.log(`[${jobId}] Exporting as ${output_format}`);
    const exportFormat = output_format === 'png' ? 'png' : 'jpg:0.85';
    const imgBuffer = await exportDocument(page, exportFormat, 120000);

    const b64 = imgBuffer.toString('base64');
    jobs.set(jobId, {
      status: 'complete',
      result: b64,
      error: null,
      contentType,
      matchLog,
      engine: 'photopea-headless',
      startedAt: jobs.get(jobId).startedAt,
    });
    console.log(`[${jobId}] complete (${(b64.length / 1024).toFixed(0)} KB b64)`);

  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ── Photopea message helpers ────────────────────────────────────────────────

/**
 * Runs a script in Photopea and waits for completion.
 * The script is wrapped in try/catch; echoToOE results are collected.
 * Returns an array of echoToOE string messages.
 */
async function runScript(page, script, timeoutMs = 120000) {
  const startLen = await page.evaluate(() => window.__msgQueue.length);

  const wrapped = `try { ${script} } catch(e) { app.echoToOE("__ERROR:" + e.toString()); }`;

  await page.evaluate((s) => {
    document.getElementById('pe').contentWindow.postMessage(s, '*');
  }, wrapped);

  // Wait for "done" and collect echoToOE messages
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate((start) => {
      for (let i = start; i < window.__msgQueue.length; i++) {
        if (window.__msgQueue[i] === 'done') {
          const messages = [];
          for (let j = start; j < i; j++) {
            if (typeof window.__msgQueue[j] === 'string' && window.__msgQueue[j] !== 'done') {
              messages.push(window.__msgQueue[j]);
            }
          }
          window.__msgQueue.splice(0, i + 1);
          return { messages };
        }
      }
      return null;
    }, startLen);

    if (result) {
      const error = result.messages.find(m => m.startsWith('__ERROR'));
      if (error) throw new Error(`Photopea: ${error.substring(8)}`);
      return result.messages;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Photopea script timeout after ${timeoutMs}ms`);
}

/**
 * Exports the active document via saveToOE.
 * Returns a Buffer containing the image data.
 */
async function exportDocument(page, format, timeoutMs = 120000) {
  const startLen = await page.evaluate(() => window.__msgQueue.length);

  await page.evaluate((s) => {
    document.getElementById('pe').contentWindow.postMessage(s, '*');
  }, `app.activeDocument.saveToOE("${format}");`);

  // Wait for ArrayBuffer followed by "done"
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate((start) => {
      for (let i = start; i < window.__msgQueue.length; i++) {
        if (window.__msgQueue[i] instanceof ArrayBuffer) {
          if (i + 1 < window.__msgQueue.length && window.__msgQueue[i + 1] === 'done') {
            const arr = Array.from(new Uint8Array(window.__msgQueue[i]));
            window.__msgQueue.splice(0, i + 2);
            return arr;
          }
        }
      }
      return null;
    }, startLen);

    if (result) return Buffer.from(result);
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Photopea export timeout after ${timeoutMs}ms`);
}

/**
 * Waits for a specific string message from Photopea.
 */
async function waitForMessage(page, expected, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((expected) => {
      for (let i = 0; i < window.__msgQueue.length; i++) {
        if (window.__msgQueue[i] === expected) {
          window.__msgQueue.splice(0, i + 1);
          return true;
        }
      }
      return false;
    }, expected);
    if (found) return;
    await new Promise(r => setTimeout(r, 300));
  }
  // On timeout, dump queue contents for debugging
  const queueInfo = await page.evaluate(() => {
    return window.__msgQueue.map(m => {
      if (typeof m === 'string') return m.substring(0, 200);
      if (m instanceof ArrayBuffer) return `[ArrayBuffer ${m.byteLength} bytes]`;
      return String(m).substring(0, 200);
    });
  }).catch(() => 'unable to read queue');
  throw new Error(`Timeout waiting for message: ${expected}. Queue (${queueInfo.length} msgs): ${JSON.stringify(queueInfo)}`);
}

// ── Utils ────────────────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

app.listen(PORT, () => console.log(`Photopea render service (headless) listening on :${PORT}`));
