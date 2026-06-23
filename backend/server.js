import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateLicenseHandler } from './api/validate-license.js';
import { registerOrgHandler } from './api/register-org.js';
import { downloadInstallerHandler } from './api/download-installer.js';
import { squareWebhookHandler } from './api/square-webhook.js';
import { createCheckoutHandler } from './api/create-checkout.js';
import {
  translateHandler,
  listTranslationsHandler,
  getTranslationHandler,
  getTranslationFileHandler,
  clearTranslationsHandler,
} from './api/translations.js';
import {
  listBugReportsHandler,
  getBugReportHandler,
  createBugReportHandler,
  addBugReportCommentHandler,
  updateBugReportStatusHandler,
  updateBugReportDetailsHandler,
} from './api/bug-reports.js';
import { loadLicenses, loadNews, loadReviews } from './lib/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

const ELECTRON_ORIGINS = /^http:\/\/localhost:(5173|[0-9]+)$/;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ELECTRON_ORIGINS.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// Documents are sent as base64 in the JSON body, which inflates the on-disk size by ~33%.
// This is a localhost-only helper serving a single desktop user, so a generous cap is safe
// and avoids rejecting large (image-heavy) PDFs/Office files as "request entity too large".
app.use(express.json({ limit: '250mb' }));
app.use(express.urlencoded({ extended: false, limit: '250mb' }));
app.use(express.static(path.join(__dirname, 'web')));
app.use('/site', express.static(path.join(__dirname, 'web')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mdas-licensing-api' });
});

app.get('/health/signature', async (_req, res) => {
  try {
    const result = await loadLicenses();
    res.json({
      ok: true,
      signature: {
        verified: Boolean(result?.signature?.verified),
        reason: result?.signature?.reason || 'unknown',
        signedAt: result?.signedAt || null,
      },
      licenseCount: Array.isArray(result?.json) ? result.json.length : 0,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || 'Signature health check failed',
    });
  }
});

app.post('/api/validate-license', validateLicenseHandler);
app.get('/api/license/:key', async (req, res) => {
  req.body = { licenseKey: req.params.key };
  return validateLicenseHandler(req, res);
});
app.post('/api/register-org', registerOrgHandler);
app.get('/api/download-installer', downloadInstallerHandler);
app.post('/api/square-webhook', squareWebhookHandler);
app.post('/create-checkout', createCheckoutHandler);
app.post('/api/translate', translateHandler);
app.get('/api/translations', listTranslationsHandler);
app.delete('/api/translations', clearTranslationsHandler);
app.get('/api/translation/:id', getTranslationHandler);
app.get('/api/translation/:id/file', getTranslationFileHandler);
app.get('/api/bug-reports', listBugReportsHandler);
app.get('/api/bug-reports/:id', getBugReportHandler);
app.post('/api/bug-reports', createBugReportHandler);
app.post('/api/bug-reports/:id/comments', addBugReportCommentHandler);
app.patch('/api/bug-reports/:id/status', updateBugReportStatusHandler);
app.patch('/api/bug-reports/:id', updateBugReportDetailsHandler);

app.get('/news.json', async (_req, res) => {
  try {
    const data = await loadNews();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/reviews.json', async (_req, res) => {
  try {
    const data = await loadReviews();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

app.get('/pricing', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'pricing.html'));
});

app.get('/license', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'license-delivery.html'));
});

app.get('/download', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'download.html'));
});

app.get('/checkout', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'checkout.html'));
});

const server = app.listen(port, host, () => {
  console.log(`MDAS backend API listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
