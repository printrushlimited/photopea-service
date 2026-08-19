const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256mb' }));
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'page.html')));

let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

app.post('/render', async (req, res) => {
  const { psd_url, output_format = 'jpg', replacements = [] } = req.body;
  if (!psd_url) return res.status(400).send('psd_url is required');
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const b64 = await page.evaluate(async (params) => window.runRender(params), { psd_url, output_format, replacements });
    if (!b64) throw new Error('No output returned from Photopea');
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', output_format === 'png' ? 'image/png' : 'image/jpeg');
    return res.send(buf);
  } catch (err) {
    console.error('Render failed:', err.message);
    return res.status(500).send(err.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

app.listen(PORT, () => console.log(`Photopea render service listening on :${PORT}`));
