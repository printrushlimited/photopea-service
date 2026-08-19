/**
 * PSD Render Service (ag-psd)
 *
 * Architecture: Base44 → this API → rendered PNG/JPEG
 *
 * - TEXT layers: manually render the child's name onto the text layer's canvas
 *   using @napi-rs/canvas (ag-psd uses pre-rasterized pixels, not text data).
 * - ARTWORK layers (smart objects / pixel layers): replace the layer's canvas
 *   with the child's artwork image, using 'multiply' blend mode so white scan
 *   backgrounds become transparent.
 * - COMPOSITE: re-write the modified PSD and re-read with composite: true so
 *   ag-psd's built-in compositor handles blend modes, layer masks, clipping
 *   masks, opacity, and effects. Falls back to a manual compositor if that
 *   fails.
 *
 * API:
 *   POST /render  → 202 { job_id }
 *   GET  /status/:job_id → { status, result(base64), error, contentType, layers, matchLog, compositeMethod }
 *   POST /layers → { width, height, layers[] }  (inspection only)
 *   GET  /test-text → diagnostic: which fillText configs produce pixels
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

// Diagnostic: test which fillText/strokeText configurations actually produce pixels
app.get('/test-text', (req, res) => {
  const tests = [];
  const variants = [
    { label: 'fill_red_Arial', fill: 'red', font: '30px Arial', method: 'fill' },
    { label: 'fill_black_Arial', fill: 'black', font: '30px Arial', method: 'fill' },
    { label: 'fill_hex_Arial', fill: '#000000', font: '30px Arial', method: 'fill' },
    { label: 'fill_black_DejaVu', fill: 'black', font: '30px "DejaVu Sans"', method: 'fill' },
    { label: 'fill_black_sans', fill: 'black', font: '30px sans-serif', method: 'fill' },
    { label: 'stroke_black_Arial', stroke: 'black', font: '30px Arial', method: 'stroke' },
    { label: 'fill_black_Arial_quoted', fill: 'black', font: '30px "Arial"', method: 'fill' },
  ];
  for (const v of variants) {
    const c = createCanvas(200, 80);
    const cx = c.getContext('2d');
    cx.font = v.font;
    cx.textBaseline = 'top';
    if (v.method === 'stroke') { cx.strokeStyle = v.stroke; cx.strokeText('Hello', 10, 20); }
    else { cx.fillStyle = v.fill; cx.fillText('Hello', 10, 20); }
    const px = cx.getImageData(10, 20, 1, 1).data;
    // Scan a wider area
    let foundNonZero = false;
    const data = cx.getImageData(0, 0, 200, 80).data;
    for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) { foundNonZero = true; break; } }
    tests.push({ label: v.label, sample_pixel: [px[0], px[1], px[2], px[3]], has_any_pixels: foundNonZero });
  }
  return res.json({ families: GlobalFonts.families.map(f => f.family), tests });
});

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
  const psd = readPsd(psdBuffer);
  console.log(`[${jobId}] parsed: ${psd.width}×${psd.height}, ${replacements.length} replacement(s)`);

  const textReps = replacements.filter(r => r.type === 'text');
  const artworkReps = replacements.filter(r => r.type === 'artwork' || r.type === 'smart_object');

  // 3. TEXT: manually render the child's name onto each text layer's canvas.
  //    ag-psd uses pre-rasterized image data from the PSD (not text data), so
  //    modifying layer.text.text doesn't change the visible canvas. We render
  //    the text ourselves using @napi-rs/canvas.
  const matchLog = [];
  for (const rep of textReps) {
    const layer = findLayerByName(psd.children || [], rep.layer_name);
    if (!layer) {
      matchLog.push({ rep: rep.layer_name, status: 'text_layer_not_found' });
      continue;
    }
    const info = replaceText(layer, rep.text);
    matchLog.push({ rep: rep.layer_name, status: info ? 'text_rendered' : 'text_failed', ...info });
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

  // 5. Composite using ag-psd's built-in renderer
  //    Re-write the modified PSD and re-read with composite: true so ag-psd's
  //    internal compositor handles blend modes, layer masks, clipping masks,
  //    opacity, and effects — not our limited custom compositor.
  let composite;
  let compositeMethod = 'ag-psd';
  try {
    psd.bitsPerChannel = 8;
    const modifiedBuffer = writePsd(psd);
    const reRead = readPsd(modifiedBuffer, { composite: true });
    if (reRead.composite) {
      composite = reRead.composite;
    } else {
      throw new Error('ag-psd did not generate a composite canvas');
    }
  } catch (e) {
    console.warn(`[${jobId}] ag-psd composite failed, falling back to manual: ${e.message}`);
    compositeMethod = 'manual_fallback';
    composite = createCanvas(psd.width, psd.height);
    const ctx = composite.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, psd.width, psd.height);
    drawLayersManual(ctx, psd.children || []);
  }

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

  // 6. Export — flatten onto white for JPG (ag-psd composite is RGBA)
  let exportCanvas = composite;
  if (output_format !== 'png') {
    exportCanvas = createCanvas(psd.width, psd.height);
    const ectx = exportCanvas.getContext('2d');
    ectx.fillStyle = '#ffffff';
    ectx.fillRect(0, 0, psd.width, psd.height);
    ectx.drawImage(composite, 0, 0);
  }

  const outBuffer = output_format === 'png'
    ? exportCanvas.toBuffer('image/png')
    : exportCanvas.toBuffer('image/jpeg', 85);

  const b64 = outBuffer.toString('base64');
  jobs.set(jobId, { status: 'complete', result: b64, error: null, contentType, layers: allLayerNames, matchLog, compositeMethod, startedAt: jobs.get(jobId).startedAt });
  console.log(`[${jobId}] complete (${(b64.length / 1024).toFixed(0)} KB b64, ${compositeMethod})`);
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

// Fallback compositor — only used if ag-psd's built-in composite fails
function drawLayersManual(ctx, layers) {
  if (!layers || layers.length === 0) return;
  for (const layer of layers) {
    if (layer.hidden) continue;
    if (layer.children) { drawLayersManual(ctx, layer.children); continue; }
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

function replaceText(layer, text) {
  const w = (layer.right || 0) - (layer.left || 0);
  const h = (layer.bottom || 0) - (layer.top || 0);
  if (w <= 0 || h <= 0) return null;

  // Extract font size from the PSD text data (don't worry about font family —
  // just use Arial/DejaVu Sans which we've registered). The PSD's transform
  // matrix scales the text from internal size to layer space.
  const t = layer.text || {};
  const style = t.style?.[0] || t.style || {};
  const transform = t.transform || [];
  const transformScale = transform[0] || transform[3] || 1;
  const baseFontSize = style.fontSize || t.fontSize || 24;
  const fontSize = Math.round(baseFontSize * transformScale);
  const paraStyle = t.paragraphStyle?.[0] || t.paragraphStyle || {};
  const alignment = paraStyle.alignment || style.alignment || t.alignment || 'left';
  const fillRGB = style.fillColor?.[0]?.rgb || style.fillColor?.rgb || t.fillColor?.[0]?.rgb || t.fillColor?.rgb || { r: 0, g: 0, b: 0 };

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.font = `${fontSize}px Arial`;
  ctx.fillStyle = `rgb(${fillRGB.r}, ${fillRGB.g}, ${fillRGB.b})`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = alignment === 'center' ? 'center' : alignment === 'right' ? 'right' : 'left';

  const lines = text.split('\n');
  const lineHeight = fontSize * 1.2;
  const startY = h / 2 - ((lines.length - 1) * lineHeight) / 2;
  const x = alignment === 'center' ? w / 2 : alignment === 'right' ? w : 0;

  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x, startY + i * lineHeight);
  }

  // Check if fillText actually produced pixels
  const data = ctx.getImageData(0, 0, w, h).data;
  let hasPixels = false;
  for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) { hasPixels = true; break; } }

  layer.canvas = canvas;
  return { fontSize, alignment, has_pixels: hasPixels, color: fillRGB };
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
