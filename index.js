/**
 * PSD Render Service (ag-psd)
 *
 * Server-side PSD rendering WITHOUT a browser. Parses PSD files, replaces
 * artwork layers (smart objects / pixel layers) and text layers, then
 * composites everything to a single PNG or JPEG.
 *
 * This replaces the old Puppeteer + Photopea approach, which never worked
 * because Photopea is a WebGL/WASM app that doesn't initialize in headless
 * Chrome (it sends zero postMessages — see git history for the long saga).
 *
 * ag-psd is a pure-JS PSD parser. @napi-rs/canvas provides the canvas
 * rasterization (prebuilt, no system deps needed).
 *
 * API (unchanged from v1 — Base44 backend function needs no changes):
 *   POST /render  → 202 { job_id }            (async, bypasses gateway timeout)
 *   GET  /status/:job_id → { status, result(base64), error, contentType }
 */
const express = require('express');
const { readPsd, initializeCanvas } = require('ag-psd');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const crypto = require('crypto');

// ag-psd v30+ requires canvas initialization before parsing.
// Pass the createCanvas function directly (not an object).
initializeCanvas(createCanvas);

const app = express();
app.use(express.json({ limit: '256mb' }));

const PORT = process.env.PORT || 8080;
const JOB_TTL_MS = 10 * 60 * 1000;

const jobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.startedAt < cutoff) jobs.delete(id);
}, 60 * 1000).unref?.();

function newJobId() {
  return crypto.randomBytes(9).toString('base64url');
}

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

// Diagnostic: list all layer names in a PSD (case-sensitive) so admins can
// verify their layer mappings match exactly.
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

  // 2. Parse with canvas support (creates canvases for ALL layers — backgrounds,
  //    decorative layers, etc. — so we can composite the full PSD)
  console.log(`[${jobId}] parsing PSD…`);
  const psd = readPsd(psdBuffer);
  console.log(`[${jobId}] parsed: ${psd.width}×${psd.height}, ${replacements.length} replacement(s)`);

  // 3. Pre-load all artwork images
  const artworkCache = new Map();
  for (const rep of replacements) {
    if (rep.type === 'artwork' && rep.image_url && !artworkCache.has(rep.image_url)) {
      console.log(`[${jobId}] loading artwork: ${rep.image_url.substring(0, 80)}…`);
      artworkCache.set(rep.image_url, await loadImageFromUrl(rep.image_url));
    }
  }

  // 4. Walk layers (bottom-to-top), apply replacements, composite to one canvas.
  //    PSD stores layers top-to-bottom (first child = topmost), but canvas
  //    compositing draws later operations on top — so iterate in REVERSE
  //    (bottommost layer first, topmost last).
  const composite = createCanvas(psd.width, psd.height);
  const ctx = composite.getContext('2d');

  // JPEG doesn't support transparency — fill with white so empty areas don't
  // render as black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, psd.width, psd.height);

  // Collect all layer names for diagnostics
  const allLayerNames = [];
  function collectNames(layers) {
    if (!layers) return;
    for (const layer of layers) {
      allLayerNames.push(layer.name);
      if (layer.children) collectNames(layer.children);
    }
  }
  collectNames(psd.children || []);

  let applied = 0;
  const matchLog = [];
  function drawLayers(layers) {
    if (!layers || layers.length === 0) return;
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (layer.hidden) continue;
      // Children are within the group — draw them first (also in reverse)
      if (layer.children) drawLayers(layer.children);

      // Apply replacements by matching layer name
      for (const rep of replacements) {
        if (layer.name !== rep.layer_name) continue;
        const w = (layer.right || 0) - (layer.left || 0);
        const h = (layer.bottom || 0) - (layer.top || 0);
        const diag = { rep: rep.layer_name, layer_bounds: { w, h, left: layer.left, top: layer.top }, had_canvas_before: !!layer.canvas };
        try {
          if (rep.type === 'text') {
            if (w <= 0 || h <= 0) { matchLog.push({ ...diag, status: 'skipped_no_bounds' }); continue; }
            const tInfo = replaceText(layer, rep.text);
            applied++;
            matchLog.push({ ...diag, status: 'applied_text', text: rep.text, style: tInfo });
          } else if (rep.type === 'artwork') {
            const img = artworkCache.get(rep.image_url);
            if (!img) { matchLog.push({ ...diag, status: 'no_artwork_image' }); continue; }
            if (w <= 0 || h <= 0) { matchLog.push({ ...diag, status: 'skipped_no_bounds' }); continue; }
            const aInfo = replaceArtwork(layer, img);
            applied++;
            matchLog.push({ ...diag, status: 'applied_artwork', img_dims: { w: img.width, h: img.height }, scale: aInfo?.scale });
          }
        } catch (e) {
          matchLog.push({ ...diag, status: 'error', error: e.message });
          console.error(`[${jobId}] replace "${layer.name}": ${e.message}`);
        }
      }

      // Draw this layer's canvas onto the composite
      if (layer.canvas) {
        ctx.save();
        // ag-psd stores opacity as 0-255 (matching PSD format); handle
        // the 0-1 case defensively in case a future version normalizes.
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

  // Log unmatched replacements
  for (const rep of replacements) {
    if (!allLayerNames.includes(rep.layer_name)) {
      matchLog.push({ rep: rep.layer_name, status: 'NO_MATCH', available: allLayerNames });
    }
  }

  console.log(`[${jobId}] layers found: ${JSON.stringify(allLayerNames)}`);
  console.log(`[${jobId}] match log: ${JSON.stringify(matchLog)}`);
  console.log(`[${jobId}] composited (${applied}/${replacements.length} replacements applied)`);

  // 5. Export to PNG or JPEG
  const outBuffer = output_format === 'png'
    ? composite.toBuffer('image/png')
    : composite.toBuffer('image/jpeg', 85);

  const b64 = outBuffer.toString('base64');
  jobs.set(jobId, { status: 'complete', result: b64, error: null, contentType, layers: allLayerNames, matchLog, startedAt: jobs.get(jobId).startedAt });
  console.log(`[${jobId}] complete (${(b64.length / 1024).toFixed(0)} KB b64)`);
}

// ── Layer replacement helpers ────────────────────────────────────────────────

function replaceText(layer, text) {
  const w = (layer.right || 0) - (layer.left || 0);
  const h = (layer.bottom || 0) - (layer.top || 0);
  if (w <= 0 || h <= 0) return null;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  // Extract text style from the PSD's text data
  const style = layer.text?.style?.[0] || {};
  const paraStyle = layer.text?.paragraphStyle || {};

  const fontSize = Math.round(style.fontSize || 24);
  let fontName = style.font?.name || 'Arial';
  // Map common PostScript font names to CSS families
  fontName = fontName.replace(/MT$|PS$|-Regular$|-Bold$|-Italic$|-BoldItalic$/g, '').replace(/-/g, ' ');

  const bold = style.bold || /bold/i.test(style.font?.name || '');
  const italic = style.italic || /italic/i.test(style.font?.name || '');
  const fillRGB = style.fillColor?.[0]?.rgb || style.fillColor?.rgb || { r: 0, g: 0, b: 0 };
  const alignment = paraStyle.alignment || style.alignment || 'left';

  ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px "${fontName}", Arial, sans-serif`;
  ctx.fillStyle = `rgb(${fillRGB.r}, ${fillRGB.g}, ${fillRGB.b})`;
  ctx.textBaseline = 'top';
  ctx.textAlign = alignment === 'center' ? 'center' : alignment === 'right' ? 'right' : 'left';

  // Multi-line text with vertical centering
  const lines = text.split('\n');
  const lineHeight = fontSize * 1.2;
  const totalHeight = lines.length * lineHeight;
  const startY = Math.max(0, (h - totalHeight) / 2);
  const x = alignment === 'center' ? w / 2 : alignment === 'right' ? w : 0;

  lines.forEach((line, i) => {
    ctx.fillText(line, x, startY + i * lineHeight);
  });

  layer.canvas = canvas;

  // Sample center pixel to verify text was drawn
  const px = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
  return { font: fontName, fontSize, bold, italic, color: fillRGB, alignment, canvas_dims: { w, h }, center_pixel: [px[0], px[1], px[2], px[3]] };
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

  // Sample center pixel to verify artwork was drawn
  const px = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
  return { scale, draw_dims: { w: dw, h: dh }, center_pixel: [px[0], px[1], px[2], px[3]] };
}

app.listen(PORT, () => console.log(`PSD render service (ag-psd) listening on :${PORT}`));
