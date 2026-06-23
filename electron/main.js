/**
 * main.js — Electron Main Process
 * Creates the browser window and sets up secure IPC channels
 * between the renderer (React UI) and Node.js APIs.
 */

import { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import Store from 'electron-store';
import keytar from 'keytar';
import { config as loadDotenv } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In packaged builds the .env lives in resources/ (extraResources) so it can
// be read as a plain file. In dev it lives next to main.js.
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');
loadDotenv({ path: envPath });

// Persistent settings store (stored in user data dir, never in repo)
const store = new Store({
  defaults: {
    targetLanguages: ['en', 'zh'],
    license: {
      org: null,
      type: null,
      limit: 0,
      requests: 0,
      charLimit: 0,
      characters: 0,
      valid: false,
    },
  },
});

const KEYTAR_SERVICE = 'mdas';
const KEYTAR_ACCOUNT = 'license-session';
const KEYTAR_LICENSE_KEY_ACCOUNT = 'license-key';

const LOCAL_HELPER_HOST = '127.0.0.1';
const LOCAL_HELPER_PORT = Number(process.env.LOCAL_HELPER_PORT || 8787);
const LICENSE_API_BASE_URL = `http://${LOCAL_HELPER_HOST}:${LOCAL_HELPER_PORT}`;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || '';
const PRICING_PAGE_URL = process.env.PRICING_PAGE_URL || 'https://example.github.io/mdas/pricing.html';
const ADMIN_PASSWORD = process.env.MDAS_ADMIN_PASSWORD || '';

let adminUnlocked = false;
let localHelperProcess = null;
let appIsQuitting = false;

function resolveBackendServerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'server.js');
  }
  return path.join(__dirname, '..', 'backend', 'server.js');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLocalHelperReady(maxAttempts = 40, intervalMs = 250) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${LICENSE_API_BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // Local helper still starting up.
    }
    await sleep(intervalMs);
  }
  throw new Error(`Local helper did not become ready at ${LICENSE_API_BASE_URL}.`);
}

async function startLocalHelperServer() {
  if (localHelperProcess && !localHelperProcess.killed) return;

  const serverPath = resolveBackendServerPath();
  if (!existsSync(serverPath)) {
    throw new Error(`Local helper server not found at ${serverPath}.`);
  }

  const stderrBuffer = [];

  localHelperProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: LOCAL_HELPER_HOST,
      PORT: String(LOCAL_HELPER_PORT),
      MDAS_USER_DATA_DIR: app.getPath('userData'),
    },
    stdio: 'pipe',
  });

  localHelperProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(`[local-helper] ${chunk}`);
  });

  localHelperProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(`[local-helper] ${chunk}`);
    stderrBuffer.push(chunk.toString());
  });

  localHelperProcess.on('exit', (code, signal) => {
    localHelperProcess = null;
    if (!appIsQuitting) {
      console.error(`Local helper exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
    }
  });

  try {
    await waitForLocalHelperReady();
  } catch (err) {
    const detail = stderrBuffer.join('').trim().slice(0, 1200);
    throw new Error(`${err.message}${detail ? `\n\nBackend error:\n${detail}` : ''}`);
  }
}

async function stopLocalHelperServer() {
  const proc = localHelperProcess;
  localHelperProcess = null;
  if (!proc || proc.killed) return;

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
    proc.kill('SIGTERM');
  } catch {
    // Ignore shutdown errors.
  }
}

async function readLicenseSession() {
  const raw = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveLicenseSession(session) {
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, JSON.stringify(session));
}

async function clearLicenseSession() {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
}

async function readCachedLicenseKey() {
  const value = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_LICENSE_KEY_ACCOUNT);
  return value ? value.trim() : '';
}

async function saveCachedLicenseKey(licenseKey) {
  const normalized = String(licenseKey || '').trim();
  if (!normalized) return;
  await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_LICENSE_KEY_ACCOUNT, normalized);
}

async function clearCachedLicenseKey() {
  await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_LICENSE_KEY_ACCOUNT);
}

async function validateWithBackend(payload, token) {
  const response = await fetch(`${LICENSE_API_BASE_URL}/api/validate-license`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || 'License API request failed');
  }

  return response.json();
}

function buildSessionFromResult(result, previousSession = {}) {
  return {
    token: result.token || previousSession.token,
    org: result.org ?? previousSession.org,
    type: result.type ?? previousSession.type,
    limit: Number(result.limit ?? previousSession.limit ?? 0),
    requests: Number(result.requests ?? previousSession.requests ?? 0),
    charLimit: Number(result.charLimit ?? previousSession.charLimit ?? 0),
    characters: Number(result.characters ?? previousSession.characters ?? 0),
    expiresAt: Number(result.expires_at ?? previousSession.expiresAt ?? 0),
    validatedAt: Date.now(),
  };
}

function persistStoreLicense(session) {
  store.set('license', {
    org: session.org,
    type: session.type,
    limit: session.limit,
    requests: session.requests,
    charLimit: session.charLimit,
    characters: session.characters,
    valid: true,
  });
}

async function refreshViaCachedLicenseKey() {
  const cachedLicenseKey = await readCachedLicenseKey();
  if (!cachedLicenseKey) {
    return { valid: false };
  }

  const result = await validateWithBackend({ licenseKey: cachedLicenseKey });
  if (!result.valid) {
    return { valid: false, reason: result.reason || 'invalid' };
  }

  const session = buildSessionFromResult(result);
  await saveLicenseSession(session);
  await saveCachedLicenseKey(cachedLicenseKey);
  persistStoreLicense(session);
  return { valid: true, ...session };
}

async function refreshLicenseSession({ allowStale = true } = {}) {
  const session = await readLicenseSession();
  if (!session?.token) {
    try {
      return await refreshViaCachedLicenseKey();
    } catch {
      return { valid: false };
    }
  }

  try {
    const result = await validateWithBackend({}, session.token);
    if (!result.valid) {
      await clearLicenseSession();
      try {
        return await refreshViaCachedLicenseKey();
      } catch {
        store.set('license', {
          org: null,
          type: null,
          limit: 0,
          requests: 0,
          charLimit: 0,
          characters: 0,
          valid: false,
        });
        return { valid: false, reason: result.reason || 'invalid' };
      }
    }

    const refreshed = buildSessionFromResult(result, session);

    await saveLicenseSession(refreshed);
    persistStoreLicense(refreshed);

    return { valid: true, ...refreshed };
  } catch {
    if (!allowStale) {
      throw new Error('Unable to refresh license session.');
    }
    return { valid: true, ...session, stale: true };
  }
}

async function requestLocalHelper(pathname, options = {}) {
  const response = await fetch(`${LICENSE_API_BASE_URL}${pathname}`, options);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Local helper request failed for ${pathname}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    content: buffer.toString('base64'),
    encoding: 'base64',
  };
}

function resolveConfiguredTargetLanguage(langAlias) {
  const configuredThird = String(store.get('customLanguageCode') || '').trim().toLowerCase();
  if (langAlias === 'third') {
    return configuredThird || null;
  }
  return langAlias;
}

function assertAdmin() {
  if (!adminUnlocked) {
    throw new Error('Admin mode is required for this action.');
  }
}

let mainWindow;

// ─── Window Creation ───────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'Logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
    titleBarStyle: 'hiddenInset',
    show: false,
  });

  // Prefer Vite when running unpackaged. Fallback to built file if available.
  const rendererDistIndex = path.join(__dirname, 'renderer', 'dist', 'index.html');
  const devUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173';
  const useDevServer = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (useDevServer) {
    mainWindow.loadURL(devUrl).catch(async () => {
      if (existsSync(rendererDistIndex)) {
        await mainWindow.loadFile(rendererDistIndex);
        return;
      }

      dialog.showErrorBox(
        'Renderer not available',
        `Could not load ${devUrl}. Start Vite with \"npm run dev --prefix electron\" or build the renderer first.`
      );
    });

    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools();
    }
  } else if (existsSync(rendererDistIndex)) {
    mainWindow.loadFile(rendererDistIndex);
  } else {
    dialog.showErrorBox(
      'Build not found',
      'Missing renderer build at electron/renderer/dist/index.html. Run "npm run build --prefix electron" first.'
    );
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startLocalHelperServer()
    .then(async () => {
      if (process.env.MDAS_ENV === 'dev') {
        // Auto-inject a dev license session so no activation is needed locally.
        // The token encodes DEV-0000-0000-0000 with a year-2100 expiry.
        const DEV_KEY = 'DEV-0000-0000-0000';
        const DEV_TOKEN = `mdas_${Buffer.from(`${DEV_KEY}:4102444800000`).toString('base64url')}`;
        await saveLicenseSession({
          token: DEV_TOKEN,
          org: 'dev-org',
          type: 'T2',
          valid: true,
          limit: 99999,
          requests: 0,
          charLimit: 999999999,
          characters: 0,
          validatedAt: Date.now(),
        });
      }
      createWindow();
    })
    .catch((error) => {
      dialog.showErrorBox('Local Helper Failed', error.message || 'Could not start local helper service.');
      app.quit();
    });

  globalShortcut.register('F12', () => {
    BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  appIsQuitting = true;
  stopLocalHelperServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Auto-Updater ─────────────────────────────────────────────────────────────

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
// Keep update errors visible in the packaged app's logs so failures are diagnosable.
autoUpdater.logger = console;

function sendUpdateStatus(status, message = '', percent = 0) {
  mainWindow?.webContents?.send('app:updateStatus', { status, message, percent });
}

/**
 * electron-updater raises an `error` event when the GitHub releases feed has no
 * published release yet (or no matching `latest.yml`). That surfaces as a 404,
 * which is not a real failure — it just means there's nothing newer to install.
 * Treat it as "up to date" instead of a hard "Update Failed".
 */
function isNoReleaseError(err) {
  const text = `${err?.message || ''} ${err?.stack || ''}`.toLowerCase();
  return (
    text.includes('404') ||
    text.includes('no published versions') ||
    text.includes('latest.yml') ||
    text.includes('cannot find') ||
    text.includes('unable to find latest version')
  );
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', `v${info.version} available`));
autoUpdater.on('update-not-available', () => sendUpdateStatus('up-to-date'));
autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', '', Math.round(p.percent)));
autoUpdater.on('update-downloaded', () => sendUpdateStatus('ready'));
autoUpdater.on('error', (err) => {
  console.error('[auto-updater] error:', err);
  if (isNoReleaseError(err)) {
    sendUpdateStatus('up-to-date', 'No updates available.');
  } else {
    sendUpdateStatus('error', err?.message || 'Update check failed.');
  }
});

ipcMain.handle('app:checkForUpdates', () => {
  if (!app.isPackaged) {
    sendUpdateStatus('up-to-date', 'Update checks only run in packaged builds.');
    return;
  }
  // The `error` event handles failures; catch the promise too so a rejection
  // here doesn't become an unhandled rejection.
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[auto-updater] checkForUpdates rejected:', err);
  });
});

ipcMain.handle('app:installUpdate', () => {
  autoUpdater.quitAndInstall();
});

// Open external URLs from webview in the system browser instead of Electron
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith(`http://localhost:${LOCAL_HELPER_PORT}`) && !url.startsWith(`http://127.0.0.1:${LOCAL_HELPER_PORT}`)) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    contents.on('will-navigate', (e, url) => {
      if (!url.startsWith(`http://localhost:${LOCAL_HELPER_PORT}`) && !url.startsWith(`http://127.0.0.1:${LOCAL_HELPER_PORT}`)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
  }
});

ipcMain.handle('shell:openExternal', (_event, url) => shell.openExternal(url));

// ─── Settings IPC ─────────────────────────────────────────────────────────────

/** Return all persisted settings to the renderer */
ipcMain.handle('settings:get', () => store.store);

/** Persist updated settings from the renderer */
ipcMain.handle('settings:set', (_event, newSettings) => {
  store.set(newSettings);
  return { ok: true };
});

// ─── Licensing IPC ───────────────────────────────────────────────────────────

ipcMain.handle('license:validateKey', async (_event, licenseKey) => {
  const result = await validateWithBackend({ licenseKey });

  if (!result.valid) {
    await clearLicenseSession();
    store.set('license', {
      org: null,
      type: null,
      limit: 0,
      requests: 0,
      charLimit: 0,
      characters: 0,
      valid: false,
    });
    return result;
  }

  const session = buildSessionFromResult(result);

  await saveLicenseSession(session);
  await saveCachedLicenseKey(licenseKey);
  persistStoreLicense(session);

  return result;
});

ipcMain.handle('license:getSession', async () => {
  return refreshLicenseSession({ allowStale: true });
});

ipcMain.handle('license:refreshSession', async () => {
  return refreshLicenseSession({ allowStale: true });
});

ipcMain.handle('license:clearSession', async () => {
  await clearLicenseSession();
  await clearCachedLicenseKey();
  return { ok: true };
});

// ─── File-dialog IPC ──────────────────────────────────────────────────────────

/** Open a save dialog so the user can choose where to store a downloaded file */
ipcMain.handle('dialog:saveFile', async (_event, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
  });
  return canceled ? null : filePath;
});

/** Write binary data (base64) to the chosen path */
ipcMain.handle('fs:writeFile', async (_event, filePath, base64Data) => {
  const buffer = Buffer.from(base64Data, 'base64');
  await fs.writeFile(filePath, buffer);
  return { ok: true };
});

/** Open a file in the OS default application */
ipcMain.handle('shell:openPath', async (_event, filePath) => {
  await shell.openPath(filePath);
  return { ok: true };
});

ipcMain.handle('app:openPricingPage', async () => {
  // If we already hold a license key, open pricing in renewal mode so a purchase tops up that
  // key (adds credits) instead of issuing a brand-new one. New users have no cached key.
  const cachedKey = await readCachedLicenseKey();
  const url = cachedKey
    ? `${PRICING_PAGE_URL}?renew=${encodeURIComponent(cachedKey)}`
    : PRICING_PAGE_URL;
  await shell.openExternal(url);
  return { ok: true, url };
});

ipcMain.handle('admin:login', async (_event, password) => {
  if (!ADMIN_PASSWORD) {
    return { ok: false, error: 'MDAS_ADMIN_PASSWORD is not configured.' };
  }
  adminUnlocked = password === ADMIN_PASSWORD;
  return { ok: adminUnlocked };
});

ipcMain.handle('admin:logout', async () => {
  adminUnlocked = false;
  return { ok: true };
});

ipcMain.handle('admin:isUnlocked', async () => ({ ok: true, unlocked: adminUnlocked }));

// ─── Translation IPC ───────────────────────────────────────────────────────────

/**
 * Upload a file to the local helper translation API.
 * The renderer passes the file content as a base64 string.
 */
ipcMain.handle('translation:uploadFile', async (_event, { fileName, base64Content, targetLanguage = 'en', fromLanguage = '', mimeType = 'text/plain' }) => {
  const session = await readLicenseSession();
  if (!session?.token || !session?.org) {
    throw new Error('A valid license is required before uploading documents.');
  }

  const result = await requestLocalHelper('/api/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      fileName,
      base64Content,
      targetLanguage: targetLanguage || 'en',
      fromLanguage: fromLanguage || undefined,
      mimeType,
    }),
  });

  if (result?.usage) {
    const updatedSession = {
      ...session,
      requests: Number(result.usage.requests || session.requests || 0),
      limit: Number(result.usage.limit || session.limit || 0),
      characters: Number(result.usage.characters || session.characters || 0),
      charLimit: Number(result.usage.charLimit || session.charLimit || 0),
      validatedAt: Date.now(),
    };
    await saveLicenseSession(updatedSession);
    persistStoreLicense(updatedSession);
  }

  return {
    ok: true,
    ids: [result.translationId],
    name: fileName,
    targetLanguages: [targetLanguage || 'en'],
  };
});

/**
 * List translated files available for a given language.
 * Returns an array of translation metadata entries.
 */
ipcMain.handle('translation:listTranslations', async (_event, lang) => {
  const session = await readLicenseSession();
  if (!session?.token || !session?.org) {
    throw new Error('A valid license is required before browsing translations.');
  }

  const resolvedLang = String(lang || '').trim();
  if (!resolvedLang) {
    return [];
  }

  const response = await requestLocalHelper(`/api/translations?lang=${encodeURIComponent(resolvedLang)}`, {
    headers: {
      Authorization: `Bearer ${session.token}`,
    },
  });

  return Array.isArray(response?.items)
    ? response.items.map((item) => ({
        id: item.id,
        name: item.fileName,
        sha: item.id,
        lang,
        createdAt: item.createdAt,
      }))
    : [];
});

/**
 * Download a translated file from local helper/S3 storage.
 * Returns the file content as a base64 string.
 */
ipcMain.handle('translation:downloadFile', async (_event, { translationId, lang }) => {
  const session = await readLicenseSession();
  if (!session?.token || !session?.org) {
    throw new Error('A valid license is required before downloading.');
  }

  const resolvedLang = String(lang || '').trim();
  if (!translationId || !resolvedLang) {
    throw new Error('translationId and lang are required for download.');
  }

  return requestLocalHelper(`/api/translation/${encodeURIComponent(translationId)}/file?lang=${encodeURIComponent(resolvedLang)}`, {
    headers: {
      Authorization: `Bearer ${session.token}`,
    },
  });
});

/**
 * Placeholder for pending jobs queue support.
 */
ipcMain.handle('translation:listPending', async () => {
  return [];
});

ipcMain.handle('bugReports:list', async (_event, { page = 1, pageSize = 10 } = {}) => {
  const response = await requestLocalHelper(`/api/bug-reports?page=${encodeURIComponent(page)}&pageSize=${encodeURIComponent(pageSize)}`);
  return {
    items: response.items || [],
    total: Number(response.total || 0),
    page: Number(response.page || 1),
    pageSize: Number(response.pageSize || 10),
    totalPages: Number(response.totalPages || 1),
  };
});

ipcMain.handle('bugReports:get', async (_event, id) => {
  const response = await requestLocalHelper(`/api/bug-reports/${encodeURIComponent(id)}`);
  return response.item;
});

ipcMain.handle('bugReports:create', async (_event, payload) => {
  const response = await requestLocalHelper('/api/bug-reports', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload || {}),
  });
  return response.item;
});

ipcMain.handle('bugReports:addComment', async (_event, payload) => {
  assertAdmin();
  const id = String(payload?.id || '');
  const response = await requestLocalHelper(`/api/bug-reports/${encodeURIComponent(id)}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-unlocked': 'true',
    },
    body: JSON.stringify({ message: payload?.message || '' }),
  });
  return response.item;
});

ipcMain.handle('bugReports:updateStatus', async (_event, payload) => {
  assertAdmin();
  const id = String(payload?.id || '');
  const response = await requestLocalHelper(`/api/bug-reports/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-unlocked': 'true',
    },
    body: JSON.stringify({ status: payload?.status || '' }),
  });
  return response.item;
});

ipcMain.handle('bugReports:updateDetails', async (_event, payload) => {
  assertAdmin();
  const id = String(payload?.id || '');
  const response = await requestLocalHelper(`/api/bug-reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-unlocked': 'true',
    },
    body: JSON.stringify({
      title: payload?.title || '',
      description: payload?.description || '',
    }),
  });
  return response.item;
});

ipcMain.handle('app:getPublicConfig', async () => ({
  licenseApiBaseUrl: LICENSE_API_BASE_URL,
  pricingPageUrl: PRICING_PAGE_URL,
  storageBucket: AWS_S3_BUCKET,
}));
