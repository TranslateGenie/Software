import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateLicenseHandler } from './api/validate-license.js';
import { registerOrgHandler } from './api/register-org.js';
import { downloadInstallerHandler } from './api/download-installer.js';
import { squareWebhookHandler } from './api/square-webhook.js';
import { loadLicenses } from './lib/github-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
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
app.post('/api/register-org', registerOrgHandler);
app.get('/api/download-installer', downloadInstallerHandler);
app.post('/api/square-webhook', squareWebhookHandler);

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'home.html'));
});

app.get('/pricing', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'pricing.html'));
});

app.get('/register', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'register.html'));
});

app.get('/license', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'license-delivery.html'));
});

app.get('/download', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'download.html'));
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
