/**
 * PSD Render Service (ag-psd)
 *
 * Simple server-side PSD rendering:
 * - TEXT layers: modify the text string in the PSD data, re-parse so ag-psd
 *   renders it with the layer's own font/style settings. No font extraction
 *   or manual fillText needed.
 * - ARTWORK layers (smart objects / pixel layers): replace the layer's canvas
 *   with the child's artwork image, using 'multiply' blend mode so white
 *   scan backgrounds become transparent.
 *
 * API:
 *   POST /render  → 202 { job_id }
 *   GET  /status/:job_id → { status, result(base64), error, contentType }
 */
const express = require('express');
const { readPsd, writePsd, initializeCanvas } = require('ag-psd');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const crypto = require('crypto');
const fs = require('fs');

initializeCanvas(createCanvas);

// ── Font registration ───────────────────────────────────────────────────────
// Register DejaVu Sans under common aliases so ag-psd's text rendering can
// find a font when the PSD specifies Arial/Helvetica/sans-serif.
try {
  if (typeof GlobalFonts.loadSystemFonts === 'function') {
    GlobalFonts.loadSystemFonts();
  }
} catch (e) {
  console.warn('loadSystemFonts failed:', e.message);
}

const fontAliases = ['Arial', 'Helvetica', 'sans-serif'];
const systemFontPaths = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  'C:/Windows/Fonts/arial.ttf',
];

for (const p of systemFontPaths) {
  if (fs.existsSync(p)) {
    for (const alias of fontAliases) {
      try { GlobalFonts.registerFromPath(p, alias); } catch (e) { /* ignore */ }
    }
    try { GlobalFonts.registerFromPath(p, 'DejaVu Sans'); } catch (e) { /* ignore */ }
  }
}

// Fallback: download DejaVu Sans from CDN if no system fonts found
async function ensureFontsAvailable() {
  if (GlobalFonts.families.length > 0) return;
  const fontSources = [
    { url: 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf', aliases: ['Arial', 'Helvetica', 'sans-serif', 'DejaVu Sans'] },
    { url: 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf', aliases: ['Arial Bold', 'DejaVu Sans Bold'] },
  ];
  for (const f of fontSources) {
    try {
      const res = await fetch(f.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error('File too small');
      const tmpPath = `/tmp/${f.url.split('/').pop()}`;
      fs.writeFileSync(tmpPath, buf);
      for (const alias of f.aliases) {
        try { GlobalFonts.registerFromPath(tmpPath, alias); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.warn(`Font download failed (${f.url}): ${e.message}`);
    }
  }
  console.log(`Fonts after download: ${GlobalFonts.families.length} families`);
}

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

app.post('/render', (req, res) => {
  const { psd_url, output_format = 'jpg', replacements = [] } = req.body || {};
  if (!psd_url) return res.status(400).json({ error: 'psd_url is required' });

  const jobId = newJobId();
  jobs.set(jobId, { status: 'pending', result: null, error: null, contentType: null, startedAt: Date.now() });

  processRender(jobId, { psd_url, output_format, replacements }).catch((err) => {
    jobs.set(jobId, { status: 'error', result: null, error: err.message, contentType: null, startedAt: jobs.get(jobId).startedAt });
  });

  return res.status(202).json({ job_id: jobId });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  return res.json(job);
});

app.get('/health', (req, res) => res.json({ ok: true, engine: 'ag-psd' }));

// Diagnostic endpoint: list all layer names in a PSD
app.post('/layers', async (req, res) => {
  try {
    const { psd_url } = req.body || {};
    if (!psd_url) return res.status(400).json({ error: 'psd_url is required' });

    const psdRes = await fetch(psd_url);
    if (!psdRes.ok) return res.status(400).json({ error: `PSD download failed (${psdRes.status})` });
    const psdBuffer = Buffer.from(await psdRes.arrayBuffer());
    const psd = readPsd(psdBuffer);

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
          has_canvas: !!layer.canvas,
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

// ── Rendering ─────────────────────────────────────────────────────────────────

async function loadImageFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed (${res.status}): ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return loadImage(buffer);
}

// Map PSD blend modes → canvas globalCompositeOperation
const BLEND_MODES = {
  'normal': 'source-over',
  'multiply': 'multiply',
  'screen': 'screen',
  'overlay': 'overlay',
  'darken': 'darken',
  'lighten': 'lighten',
  'color dodge': 'color-dodge',
  'linear dodge': 'lighter',
  'difference': 'difference',
  'exclusion': 'exclusion',
  'hue': 'hue',
  'saturation': 'saturation',
  'color': 'color',
  'luminosity': 'luminosity',
};

async function processRender(jobId, params) {
  const { psd_url, output_format, replacements } = params;
  const contentType = output_format === 'png' ? 'image/png' : 'image/jpeg';

  jobs.set(jobId, { ...jobs.get(jobId), status: 'processing' });

  // 1. Download PSD
  console.log(`[${jobId}] downloading PSD: ${psd_url}`);
  const psdRes = await fetch(psd_url);
  if (!psdRes.ok) throw new Error(`PSD download failed (${psdRes.status})`);
  const psdBuffer = Buffer.from(await psdRes.arrayBuffer());
  console.log(`[${jobId}] PSD downloaded (${(psdBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

  // 2. Parse PSD
  console.log(`[${jobId}] parsing PSD…`);
  let psd = readPsd(psdBuffer);
  console.log(`[${jobId}] parsed: ${psd.width}×${psd.height}, ${replacements.length} replacement(s)`);

  const textReps = replacements.filter(r => r.type === 'text');
  const artworkReps = replacements.filter(r => r.type === 'artwork');

  // 3. TEXT: modify the text string in each text layer's data, then re-parse
  //    so ag-psd re-renders the text with the layer's own font/style settings.
  //    No font extraction or manual fillText — just change the text string.
  const matchLog = [];
  if (textReps.length > 0) {
    let textModified = false;
    for (const rep of textReps) {
      const layer = findLayerByName(psd.children || [], rep.layer_name);
      if (layer && layer.text) {
        const oldText = layer.text.text;
        layer.text.text = rep.text;
        textModified = true;
        matchLog.push({ rep: rep.layer_name, status: 'text_modified', old: oldText, new: rep.text });
      } else {
        matchLog.push({ rep: rep.layer_name, status: 'text_layer_not_found' });
      }
    }
    if (textModified) {
      console.log(`[${jobId}] ${textReps.length} text layer(s) modified, re-parsing…`);
      // Write modified PSD → re-read to get fresh canvases with updated text.
      // ag-psd renders text during readPsd(), so the re-read gives us
      // canvases with the new text content.
      // Force 8-bit channels — writePsd doesn't support 16/32-bit, and
      // canvases from @napi-rs/canvas are always 8-bit anyway.
      psd.bitsPerChannel = 8;
      const modifiedBuffer = writePsd(psd);
      psd = readPsd(modifiedBuffer);
    }
  }

  // 4. ARTWORK: pre-load images, then replace each artwork layer's canvas
  const artworkCache = new Map();
  for (const rep of artworkReps) {
    if (rep.image_url && !artworkCache.has(rep.image_url)) {
      console.log(`[${jobId}] loading artwork: ${rep.image_url.substring(0, 80)}…`);
      artworkCache.set(rep.image_url, await loadImageFromUrl(rep.image_url));
    }
  }

  for (const rep of artworkReps) {
    const layer = findLayerByName(psd.children || [], rep.layer_name);
    if (!layer) {
      matchLog.push({ rep: rep.layer_name, status: 'artwork_layer_not_found' });
      continue;
    }
    const img = artworkCache.get(rep.image_url);
    if (!img) {
      matchLog.push({ rep: rep.layer_name, status: 'no_artwork_image' });
      continue;
    }
    const info = replaceArtwork(layer, img);
    matchLog.push({ rep: rep.layer_name, status: 'artwork_replaced', img_dims: { w: img.width, h: img.height }, ...info });
  }

  // 5. Composite all layers to one canvas
  const composite = createCanvas(psd.width, psd.height);
  const ctx = composite.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, psd.width, psd.height);

  function drawLayers(layers) {
    if (!layers || layers.length === 0) return;
    for (const layer of layers) {
      if (layer.hidden) continue;
      // Group layer: draw children, skip group's own pre-rendered canvas
      if (layer.children) { drawLayers(layer.children); continue; }

      if (layer.canvas) {
        ctx.save();
        const op = typeof layer.opacity === 'number' ? layer.opacity : 255;
        ctx.globalAlpha = op <= 1 ? op : op / 255;
        const mode = BLEND_MODES[layer.blendMode];
        if (mode) ctx.globalCompositeOperation = mode;
        ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
        ctx.restore();
      }
    }
  }
  drawLayers(psd.children || []);

  // Log layer names + match results
  const allLayerNames = [];
  function collectNames(layers) {
    if (!layers) return;
    for (const layer of layers) {
      allLayerNames.push(layer.name);
      if (layer.children) collectNames(layer.children);
    }
  }
  collectNames(psd.children || []);

  for (const rep of replacements) {
    if (!allLayerNames.includes(rep.layer_name)) {
      matchLog.push({ rep: rep.layer_name, status: 'NO_MATCH', available: allLayerNames });
    }
  }

  console.log(`[${jobId}] layers: ${JSON.stringify(allLayerNames)}`);
  console.log(`[${jobId}] match log: ${JSON.stringify(matchLog)}`);

  // 6. Export
  const outBuffer = output_format === 'png'
    ? composite.toBuffer('image/png')
    : composite.toBuffer('image/jpeg', 85);

  const b64 = outBuffer.toString('base64');
  jobs.set(jobId, { status: 'complete', result: b64, error: null, contentType, layers: allLayerNames, matchLog, startedAt: jobs.get(jobId).startedAt });
  console.log(`[${jobId}] complete (${(b64.length / 1024).toFixed(0)} KB b64)`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findLayerByName(layers, name) {
  for (const layer of layers || []) {
    if (layer.name === name) return layer;
    if (layer.children) {
      const found = findLayerByName(layer.children, name);
      if (found) return found;
    }
  }
  return null;
}

function replaceArtwork(layer, img) {
  const w = (layer.right || 0) - (layer.left || 0);
  const h = (layer.bottom || 0) - (layer.top || 0);
  if (w <= 0 || h <= 0) return null;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  // Contain: scale artwork to fit within layer bounds, centered
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);

  layer.canvas = canvas;
  // Use 'multiply' so white scan backgrounds become transparent
  layer.blendMode = 'multiply';

  return { scale: Math.round(scale * 1000) / 1000, draw_dims: { w: dw, h: dh } };
}

ensureFontsAvailable().finally(() => {
  app.listen(PORT, () => console.log(`PSD render service (ag-psd) listening on :${PORT}`));
});
