import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateLicenseHandler } from './api/validate-license.js';
import { registerOrgHandler } from './api/register-org.js';
import { downloadInstallerHandler } from './api/download-installer.js';
import { squareWebhookHandler } from './api/square-webhook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/site', express.static(path.join(__dirname, 'web')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mdas-licensing-api' });
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

app.listen(port, () => {
  console.log(`MDAS backend API listening on http://localhost:${port}`);
});
