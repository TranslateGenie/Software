/**
 * main.js — Electron Main Process
 * Creates the browser window and sets up secure IPC channels
 * between the renderer (React UI) and Node.js APIs.
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import Store from 'electron-store';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import keytar from 'keytar';
import { config as loadDotenv } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env for local development. Silently ignored when the file is absent
// (packaged builds never ship .env).
loadDotenv({ path: path.join(__dirname, '.env') });

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
const BACKEND_REPO_OWNER = process.env.GITHUB_BACKEND_OWNER || '';
const BACKEND_REPO_NAME = process.env.GITHUB_BACKEND_REPO || '';
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '';
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '';
const PRICING_PAGE_URL = process.env.PRICING_PAGE_URL || 'https://example.github.io/mdas/pricing.html';
const BUG_REPORTS_REPO_OWNER = process.env.BUG_REPORTS_REPO_OWNER || BACKEND_REPO_OWNER;
const BUG_REPORTS_REPO_NAME = process.env.BUG_REPORTS_REPO_NAME || BACKEND_REPO_NAME;
const BUG_REPORTS_PATH = String(process.env.BUG_REPORTS_PATH || 'bug-reports').replace(/^\/+|\/+$/g, '');
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

  localHelperProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: LOCAL_HELPER_HOST,
      PORT: String(LOCAL_HELPER_PORT),
    },
    stdio: 'pipe',
  });

  localHelperProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(`[local-helper] ${chunk}`);
  });

  localHelperProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(`[local-helper] ${chunk}`);
  });

  localHelperProcess.on('exit', (code, signal) => {
    localHelperProcess = null;
    if (!appIsQuitting) {
      console.error(`Local helper exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
    }
  });

  await waitForLocalHelperReady();
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

function getAppPrivateKey() {
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY || '';
  if (!privateKey) {
    throw new Error('GitHub App private key is not configured in environment.');
  }
  return privateKey.replace(/\\n/g, '\n');
}

function ensureGitHubAppConfig() {
  if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID || !BACKEND_REPO_OWNER || !BACKEND_REPO_NAME) {
    throw new Error('GitHub App backend settings are incomplete. Set app ID, installation ID, owner, and repo.');
  }
}

async function getInstallationOctokit() {
  ensureGitHubAppConfig();
  const privateKey = getAppPrivateKey();

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: GITHUB_APP_ID,
      privateKey,
      installationId: GITHUB_APP_INSTALLATION_ID,
    },
  });
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

function getBugReportsRepoConfig() {
  if (!BUG_REPORTS_REPO_OWNER || !BUG_REPORTS_REPO_NAME) {
    throw new Error('Bug reports repository settings are incomplete. Set BUG_REPORTS_REPO_OWNER and BUG_REPORTS_REPO_NAME.');
  }
  return {
    owner: BUG_REPORTS_REPO_OWNER,
    repo: BUG_REPORTS_REPO_NAME,
  };
}

function isNotFoundError(error) {
  return Number(error?.status) === 404;
}

async function getRepoJsonFile({ owner, repo, path: filePath }) {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
  });

  if (Array.isArray(data) || !data.content) {
    throw new Error(`Expected JSON file at ${filePath}`);
  }

  const decoded = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
  return {
    json: JSON.parse(decoded),
    sha: data.sha,
    path: data.path,
  };
}

async function writeRepoJsonFile({ owner, repo, path: filePath, json, sha, message }) {
  const octokit = await getInstallationOctokit();
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

function normalizeBugReport(report, filePath) {
  return {
    id: String(report?.id || filePath?.split('/').pop()?.replace(/\.json$/i, '') || randomUUID()),
    title: String(report?.title || 'Untitled report'),
    description: String(report?.description || ''),
    createdBy: String(report?.createdBy || 'anonymous'),
    createdAt: String(report?.createdAt || new Date().toISOString()),
    status: String(report?.status || 'open'),
    comments: Array.isArray(report?.comments)
      ? report.comments.map((item) => ({
          author: String(item?.author || 'user'),
          message: String(item?.message || ''),
          timestamp: String(item?.timestamp || new Date().toISOString()),
        }))
      : [],
  };
}

async function listBugReportsRaw() {
  const { owner, repo } = getBugReportsRepoConfig();
  const octokit = await getInstallationOctokit();

  let entries = [];
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: BUG_REPORTS_PATH,
    });
    entries = Array.isArray(data)
      ? data.filter((item) => item.type === 'file' && item.name.endsWith('.json'))
      : [];
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const reports = await Promise.all(
    entries.map(async (entry) => {
      try {
        const { json } = await getRepoJsonFile({ owner, repo, path: entry.path });
        return normalizeBugReport(json, entry.path);
      } catch {
        return null;
      }
    })
  );

  return reports.filter(Boolean).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function nextBugReportId(existingIds) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const datePrefix = `${year}-${month}-${day}`;

  const used = new Set(
    existingIds
      .map((id) => String(id || ''))
      .filter((id) => id.startsWith(`${datePrefix}-`))
      .map((id) => Number(id.slice(-3)))
      .filter((value) => Number.isFinite(value))
  );

  let seq = 1;
  while (used.has(seq)) seq += 1;
  return `${datePrefix}-${String(seq).padStart(3, '0')}`;
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
    webPreferences: {
      // Load preload script to expose safe API surface
      preload: path.join(__dirname, 'preload.js'),
      // Disable Node.js in renderer for security
      nodeIntegration: false,
      contextIsolation: true,
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
    .then(() => {
      createWindow();
    })
    .catch((error) => {
      dialog.showErrorBox('Local Helper Failed', error.message || 'Could not start local helper service.');
      app.quit();
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
  await shell.openExternal(PRICING_PAGE_URL);
  return { ok: true, url: PRICING_PAGE_URL };
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

// ─── GitHub IPC ────────────────────────────────────────────────────────────────

/**
 * Upload a file to /incoming/<org>/ in the configured GitHub repository.
 * The renderer passes the file content as a base64 string.
 */
ipcMain.handle('github:uploadFile', async (_event, { fileName, base64Content }) => {
  const session = await readLicenseSession();
  if (!session?.token || !session?.org) {
    throw new Error('A valid license is required before uploading documents.');
  }

  const quota = await validateWithBackend({}, session.token);
  if (!quota?.valid) {
    throw new Error('Your translation quota has been reached. Please purchase additional request packs.');
  }

  const octokit = await getInstallationOctokit();
  const repoPath = `incoming/${session.org}/${fileName}`;

  // Check if the file already exists so we can provide the SHA for updates
  let existingSha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: BACKEND_REPO_OWNER,
      repo: BACKEND_REPO_NAME,
      path: repoPath,
    });
    existingSha = data.sha;
  } catch {
    // File does not exist yet — that is the normal first-upload case
  }

  await octokit.repos.createOrUpdateFileContents({
    owner: BACKEND_REPO_OWNER,
    repo: BACKEND_REPO_NAME,
    path: repoPath,
    message: `Upload ${fileName} for translation`,
    content: base64Content,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  return { ok: true, path: repoPath };
});

/**
 * List translated files available for a given language folder.
 * Returns an array of { name, downloadUrl, sha } objects.
 */
ipcMain.handle('github:listTranslations', async (_event, lang) => {
  const session = await readLicenseSession();
  if (!session?.token || !session?.org) {
    throw new Error('A valid license is required before browsing translations.');
  }

  const octokit = await getInstallationOctokit();

  try {
    const { data } = await octokit.repos.getContent({
      owner: BACKEND_REPO_OWNER,
      repo: BACKEND_REPO_NAME,
      path: `translations/${session.org}/${lang}`,
    });

    // Filter out .gitkeep placeholder
    const files = Array.isArray(data)
      ? data
          .filter((f) => f.type === 'file' && f.name !== '.gitkeep')
          .map(({ name, download_url, sha }) => ({ name, downloadUrl: download_url, sha }))
      : [];

    return files;
  } catch {
    return [];
  }
});

/**
 * Download a translated file from GitHub.
 * Returns the file content as a base64 string.
 */
ipcMain.handle('github:downloadFile', async (_event, { filePath }) => {
  const session = await readLicenseSession();
  if (!session?.token || !session?.org) {
    throw new Error('A valid license is required before downloading.');
  }

  const octokit = await getInstallationOctokit();
  const resolvedPath = filePath.startsWith(`translations/${session.org}/`)
    ? filePath
    : filePath.startsWith('translations/')
      ? filePath.replace('translations/', `translations/${session.org}/`)
      : filePath;

  const { data } = await octokit.repos.getContent({
    owner: BACKEND_REPO_OWNER,
    repo: BACKEND_REPO_NAME,
    path: resolvedPath,
  });

  return { content: data.content, encoding: data.encoding };
});

/**
 * List files currently in incoming/<org> so the UI can show pending items.
 */
ipcMain.handle('github:listIncoming', async () => {
  const session = await readLicenseSession();
  if (!session?.token || !session?.org) return [];

  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.repos.getContent({
      owner: BACKEND_REPO_OWNER,
      repo: BACKEND_REPO_NAME,
      path: `incoming/${session.org}`,
    });
    return Array.isArray(data)
      ? data
          .filter((f) => f.type === 'file' && f.name !== '.gitkeep')
          .map(({ name, sha }) => ({ name, sha }))
      : [];
  } catch {
    return [];
  }
});

ipcMain.handle('bugReports:list', async (_event, { page = 1, pageSize = 10 } = {}) => {
  const reports = await listBugReportsRaw();
  const total = reports.length;
  const safePageSize = Math.max(1, Number(pageSize) || 10);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * safePageSize;
  const items = reports.slice(start, start + safePageSize).map((report) => ({
    id: report.id,
    title: report.title,
    createdAt: report.createdAt,
    status: report.status,
    createdBy: report.createdBy,
    commentCount: report.comments.length,
  }));

  return {
    items,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages,
  };
});

ipcMain.handle('bugReports:get', async (_event, id) => {
  const reports = await listBugReportsRaw();
  const report = reports.find((item) => item.id === id);
  if (!report) {
    throw new Error('Bug report not found.');
  }
  return report;
});

ipcMain.handle('bugReports:create', async (_event, payload) => {
  const reports = await listBugReportsRaw();
  const nextId = nextBugReportId(reports.map((item) => item.id));
  const { owner, repo } = getBugReportsRepoConfig();
  const createdAt = new Date().toISOString();
  const report = normalizeBugReport({
    id: nextId,
    title: String(payload?.title || '').trim(),
    description: String(payload?.description || '').trim(),
    createdBy: String(payload?.createdBy || 'anonymous').trim() || 'anonymous',
    createdAt,
    status: 'open',
    comments: [],
  });

  if (!report.title || !report.description) {
    throw new Error('Title and description are required.');
  }

  const reportPath = path.posix.join(BUG_REPORTS_PATH, `${report.id}.json`);
  await writeRepoJsonFile({
    owner,
    repo,
    path: reportPath,
    json: report,
    message: `chore: add bug report ${report.id} [skip ci]`,
  });

  return report;
});

ipcMain.handle('bugReports:addComment', async (_event, payload) => {
  assertAdmin();
  const { owner, repo } = getBugReportsRepoConfig();
  const id = String(payload?.id || '');
  const reportPath = path.posix.join(BUG_REPORTS_PATH, `${id}.json`);
  const { json, sha } = await getRepoJsonFile({ owner, repo, path: reportPath });
  const report = normalizeBugReport(json, reportPath);
  const message = String(payload?.message || '').trim();
  if (!message) {
    throw new Error('Comment message is required.');
  }

  report.comments.push({
    author: 'admin',
    message,
    timestamp: new Date().toISOString(),
  });

  await writeRepoJsonFile({
    owner,
    repo,
    path: reportPath,
    json: report,
    sha,
    message: `chore: comment on bug report ${report.id} [skip ci]`,
  });

  return report;
});

ipcMain.handle('bugReports:updateStatus', async (_event, payload) => {
  assertAdmin();
  const allowedStatuses = new Set(['open', 'in progress', 'resolved']);
  const nextStatus = String(payload?.status || '').toLowerCase();
  if (!allowedStatuses.has(nextStatus)) {
    throw new Error('Status must be one of: open, in progress, resolved.');
  }

  const { owner, repo } = getBugReportsRepoConfig();
  const id = String(payload?.id || '');
  const reportPath = path.posix.join(BUG_REPORTS_PATH, `${id}.json`);
  const { json, sha } = await getRepoJsonFile({ owner, repo, path: reportPath });
  const report = normalizeBugReport(json, reportPath);
  report.status = nextStatus;

  await writeRepoJsonFile({
    owner,
    repo,
    path: reportPath,
    json: report,
    sha,
    message: `chore: update bug report ${report.id} status [skip ci]`,
  });

  return report;
});

ipcMain.handle('bugReports:updateDetails', async (_event, payload) => {
  assertAdmin();
  const { owner, repo } = getBugReportsRepoConfig();
  const id = String(payload?.id || '');
  const reportPath = path.posix.join(BUG_REPORTS_PATH, `${id}.json`);
  const { json, sha } = await getRepoJsonFile({ owner, repo, path: reportPath });
  const report = normalizeBugReport(json, reportPath);

  const nextTitle = String(payload?.title || '').trim();
  const nextDescription = String(payload?.description || '').trim();
  if (!nextTitle || !nextDescription) {
    throw new Error('Title and description are required.');
  }

  report.title = nextTitle;
  report.description = nextDescription;

  await writeRepoJsonFile({
    owner,
    repo,
    path: reportPath,
    json: report,
    sha,
    message: `chore: edit bug report ${report.id} [skip ci]`,
  });

  return report;
});

ipcMain.handle('app:getPublicConfig', async () => ({
  licenseApiBaseUrl: LICENSE_API_BASE_URL,
  backendRepo: `${BACKEND_REPO_OWNER}/${BACKEND_REPO_NAME}`,
  pricingPageUrl: PRICING_PAGE_URL,
  bugReportsPath: BUG_REPORTS_PATH,
}));
