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
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const crypto = require('crypto');
const fs = require('fs');

// ag-psd v30+ requires canvas initialization before parsing.
// Pass the createCanvas function directly (not an object).
initializeCanvas(createCanvas);

// ── Font registration ───────────────────────────────────────────────────────
// @napi-rs/canvas does NOT include built-in fonts. Without registering a font,
// ctx.fillText() silently draws nothing. Try to load system fonts and register
// common aliases (Arial, Helvetica, sans-serif) so PSD text layers render.
try {
  // Try loading all system fonts first (if supported by the runtime)
  if (typeof GlobalFonts.loadSystemFonts === 'function') {
    GlobalFonts.loadSystemFonts();
  }
} catch (e) {
  console.warn('loadSystemFonts failed:', e.message);
}

// Register common system font paths under multiple family aliases
const fontAliases = ['Arial', 'Helvetica', 'sans-serif'];
const systemFontPaths = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/opensans/OpenSans-Regular.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  'C:/Windows/Fonts/arial.ttf',
];

let fontsRegistered = 0;
for (const p of systemFontPaths) {
  if (fs.existsSync(p)) {
    for (const alias of fontAliases) {
      try { GlobalFonts.registerFromPath(p, alias); fontsRegistered++; } catch (e) { /* ignore */ }
    }
    try { GlobalFonts.registerFromPath(p, 'DejaVu Sans'); fontsRegistered++; } catch (e) { /* ignore */ }
    try { GlobalFonts.registerFromPath(p, 'Liberation Sans'); fontsRegistered++; } catch (e) { /* ignore */ }
  }
}
console.log(`Fonts registered: ${fontsRegistered} alias entries`);
console.log(`Available font families: ${JSON.stringify(GlobalFonts.families.map(f => f.family))}`);

// If no system fonts were found, download DejaVu Sans from a CDN and register
// it under common aliases. Without this, ctx.fillText() draws nothing.
async function ensureFontsAvailable() {
  if (GlobalFonts.families.length > 0) return;
  console.log('No system fonts found — downloading DejaVu Sans…');
  const fontUrls = [
    { url: 'https://cdn.jsdelivr.net/gh/dejavu-fonts/dejavu-fonts/ttf/DejaVuSans.ttf', path: '/tmp/DejaVuSans.ttf', aliases: ['Arial', 'Helvetica', 'sans-serif', 'DejaVu Sans'] },
    { url: 'https://cdn.jsdelivr.net/gh/dejavu-fonts/dejavu-fonts/ttf/DejaVuSans-Bold.ttf', path: '/tmp/DejaVuSans-Bold.ttf', aliases: ['Arial Bold', 'DejaVu Sans Bold'] },
  ];
  for (const f of fontUrls) {
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(f.path, Buffer.from(await res.arrayBuffer()));
      for (const alias of f.aliases) {
        try { GlobalFonts.registerFromPath(f.path, alias); } catch (e) { /* ignore */ }
      }
      console.log(`Registered ${f.path} as: ${f.aliases.join(', ')}`);
    } catch (e) {
      console.warn(`Failed to download font from ${f.url}: ${e.message}`);
    }
  }
  console.log(`After download: ${GlobalFonts.families.length} font families`);
}

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
  //    ag-psd stores children in PSD file order: first child = bottommost layer.
  //    Canvas compositing draws later operations on top, so iterate FORWARD
  //    (bottommost first, topmost last) to match the visual layer order.
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
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.hidden) continue;
      // Children are within the group — draw them first (also forward)
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
            matchLog.push({ ...diag, status: 'applied_text', text: rep.text, style: tInfo, blend: layer.blendMode, clipping: !!layer.clipping, raw_text_keys: Object.keys(layer.text || {}), raw_text_data: JSON.stringify(layer.text || null).substring(0, 500) });
          } else if (rep.type === 'artwork') {
            const img = artworkCache.get(rep.image_url);
            if (!img) { matchLog.push({ ...diag, status: 'no_artwork_image' }); continue; }
            if (w <= 0 || h <= 0) { matchLog.push({ ...diag, status: 'skipped_no_bounds' }); continue; }
            const aInfo = replaceArtwork(layer, img);
            applied++;
            matchLog.push({ ...diag, status: 'applied_artwork', img_dims: { w: img.width, h: img.height }, scale: aInfo?.scale, draw_dims: aInfo?.draw_dims, center_pixel: aInfo?.center_pixel, blend: layer.blendMode, clipping: !!layer.clipping });
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

  // Post-composite diagnostic: sample a pixel at the center of each replaced
  // layer's bounds on the FINAL composite. If the pixel is white/transparent,
  // something above is covering the replacement.
  const postPixels = [];
  for (const rep of replacements) {
    const layer = findLayerByName(psd.children || [], rep.layer_name);
    if (!layer) continue;
    const cx = Math.floor((layer.left || 0) + ((layer.right || 0) - (layer.left || 0)) / 2);
    const cy = Math.floor((layer.top || 0) + ((layer.bottom || 0) - (layer.top || 0)) / 2);
    const px = ctx.getImageData(cx, cy, 1, 1).data;
    postPixels.push({ rep: rep.layer_name, composite_pos: { x: cx, y: cy }, pixel: [px[0], px[1], px[2], px[3]] });
  }

  // Per-layer alpha diagnostic: for each layer with a canvas, sample its OWN
  // canvas alpha at the artwork center position (in local coordinates). This
  // identifies which layer is opaque and covering the artwork.
  const layerAlphaAtArtwork = [];
  const artworkRep = replacements.find(r => r.type === 'artwork');
  if (artworkRep) {
    const awLayer = findLayerByName(psd.children || [], artworkRep.layer_name);
    if (awLayer) {
      const awCx = Math.floor((awLayer.right || 0) - (awLayer.left || 0)) / 2; // local coord
      const awCy = Math.floor((awLayer.bottom || 0) - (awLayer.top || 0)) / 2;
      function sampleLayerAlpha(layers, depth) {
        if (!layers) return;
        for (const layer of layers) {
          if (layer.canvas && !layer.hidden) {
            const lw = (layer.right || 0) - (layer.left || 0);
            const lh = (layer.bottom || 0) - (layer.top || 0);
            // Convert artwork center (composite coords) to this layer's local coords
            const localX = Math.floor((awLayer.left || 0) + awCx - (layer.left || 0));
            const localY = Math.floor((awLayer.top || 0) + awCy - (layer.top || 0));
            if (localX >= 0 && localY >= 0 && localX < lw && localY < lh) {
              try {
                const lctx = layer.canvas.getContext('2d');
                const px = lctx.getImageData(localX, localY, 1, 1).data;
                layerAlphaAtArtwork.push({ name: layer.name, local_pos: { x: localX, y: localY }, pixel: [px[0], px[1], px[2], px[3]], blend: layer.blendMode || 'normal' });
              } catch (e) { /* skip */ }
            }
          }
          if (layer.children) sampleLayerAlpha(layer.children, depth + 1);
        }
      }
      sampleLayerAlpha(psd.children || [], 0);
    }
  }

  // Also log blend mode + opacity of all layers to check z-ordering
  const layerOrder = [];
  function logOrder(layers, depth) {
    if (!layers) return;
    for (const layer of layers) {
      const w = (layer.right || 0) - (layer.left || 0);
      const h = (layer.bottom || 0) - (layer.top || 0);
      layerOrder.push({ name: layer.name, depth, blend: layer.blendMode || 'normal', opacity: layer.opacity, hidden: !!layer.hidden, has_canvas: !!layer.canvas, clipping: !!layer.clipping, size: w > 0 ? `${w}x${h}` : null });
      if (layer.children) logOrder(layer.children, depth + 1);
    }
  }
  logOrder(psd.children || [], 0);

  console.log(`[${jobId}] layers found: ${JSON.stringify(allLayerNames)}`);
  console.log(`[${jobId}] match log: ${JSON.stringify(matchLog)}`);
  console.log(`[${jobId}] post-composite pixels: ${JSON.stringify(postPixels)}`);
  console.log(`[${jobId}] per-layer alpha at artwork pos: ${JSON.stringify(layerAlphaAtArtwork)}`);
  console.log(`[${jobId}] layer order: ${JSON.stringify(layerOrder)}`);
  console.log(`[${jobId}] composited (${applied}/${replacements.length} replacements applied)`);

  // 5. Export to PNG or JPEG
  const outBuffer = output_format === 'png'
    ? composite.toBuffer('image/png')
    : composite.toBuffer('image/jpeg', 85);

  const b64 = outBuffer.toString('base64');
  jobs.set(jobId, { status: 'complete', result: b64, error: null, contentType, layers: allLayerNames, matchLog, postPixels, layerAlphaAtArtwork, layerOrder, startedAt: jobs.get(jobId).startedAt });
  console.log(`[${jobId}] complete (${(b64.length / 1024).toFixed(0)} KB b64)`);
}

// ── Layer replacement helpers ────────────────────────────────────────────────

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

function replaceText(layer, text) {
  const w = (layer.right || 0) - (layer.left || 0);
  const h = (layer.bottom || 0) - (layer.top || 0);
  if (w <= 0 || h <= 0) return null;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  // Extract text style from the PSD's text data. ag-psd stores text style
  // data in layer.text.style (array of style runs). Try multiple access paths
  // since the structure can vary between PSD versions.
  const t = layer.text || {};
  const style = t.style?.[0] || t.style || {};
  const paraStyle = t.paragraphStyle?.[0] || t.paragraphStyle || {};

  // PSD text layers store a transform matrix [a, b, c, d, tx, ty] that scales
  // the text from its internal size to layer space. The style.fontSize is the
  // UNSCALED size — we must multiply by the transform's scale factor (a or d)
  // to get the actual rendered pixel size.
  const transform = t.transform || [];
  const transformScale = transform[0] || transform[3] || 1;
  const baseFontSize = style.fontSize || t.fontSize || 24;
  const fontSize = Math.round(baseFontSize * transformScale);
  let fontName = style.font?.name || t.font?.name || style.fontFamily || t.fontFamily || 'Arial';
  // Map common PostScript font names to CSS families
  fontName = fontName.replace(/MT$|PS$|-Regular$|-Bold$|-Italic$|-BoldItalic$/g, '').replace(/-/g, ' ');

  const bold = style.bold || t.bold || /bold/i.test(style.font?.name || t.font?.name || '');
  const italic = style.italic || t.italic || /italic/i.test(style.font?.name || t.font?.name || '');
  const fillRGB = style.fillColor?.[0]?.rgb || style.fillColor?.rgb || t.fillColor?.[0]?.rgb || t.fillColor?.rgb || { r: 0, g: 0, b: 0 };
  const alignment = paraStyle.alignment || style.alignment || t.alignment || 'left';

  // Build font string — try the PSD font name first, fall back to Arial,
  // then sans-serif. @napi-rs/canvas requires fonts to be registered; if the
  // requested family isn't available, it falls back to a default.
  const fontStr = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px "${fontName}", "Arial", "sans-serif"`;
  ctx.font = fontStr;
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

  // Sample multiple pixels to verify text was drawn
  const centerPx = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data;
  const topLeftPx = ctx.getImageData(2, Math.max(0, Math.floor(startY)), 1, 1).data;
  const fontAvailable = GlobalFonts.has(fontName) || GlobalFonts.has('Arial') || (GlobalFonts.families.length > 0);
  return { font: fontName, fontSize, bold, italic, color: fillRGB, alignment, canvas_dims: { w, h }, center_pixel: [centerPx[0], centerPx[1], centerPx[2], centerPx[3]], top_left_pixel: [topLeftPx[0], topLeftPx[1], topLeftPx[2], topLeftPx[3]], font_available: fontAvailable, registered_families: GlobalFonts.families.length };
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

ensureFontsAvailable().finally(() => {
  app.listen(PORT, () => console.log(`PSD render service (ag-psd) listening on :${PORT}`));
});
