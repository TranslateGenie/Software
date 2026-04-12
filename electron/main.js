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
import Store from 'electron-store';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import keytar from 'keytar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const LICENSE_API_BASE_URL = process.env.LICENSE_API_BASE_URL || 'http://localhost:8787';
const BACKEND_REPO_OWNER = process.env.GITHUB_BACKEND_OWNER || '';
const BACKEND_REPO_NAME = process.env.GITHUB_BACKEND_REPO || '';
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '';
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '';

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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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

  const session = {
    token: result.token,
    org: result.org,
    type: result.type,
    limit: Number(result.limit || 0),
    requests: Number(result.requests || 0),
    charLimit: Number(result.charLimit || 0),
    characters: Number(result.characters || 0),
    validatedAt: Date.now(),
  };

  await saveLicenseSession(session);
  store.set('license', {
    org: session.org,
    type: session.type,
    limit: session.limit,
    requests: session.requests,
    charLimit: session.charLimit,
    characters: session.characters,
    valid: true,
  });

  return result;
});

ipcMain.handle('license:getSession', async () => {
  const session = await readLicenseSession();
  if (!session?.token) {
    return { valid: false };
  }

  try {
    const result = await validateWithBackend({}, session.token);
    if (!result.valid) {
      await clearLicenseSession();
      return { valid: false, reason: result.reason || 'invalid' };
    }

    const refreshed = {
      token: result.token || session.token,
      org: result.org ?? session.org,
      type: result.type ?? session.type,
      limit: Number(result.limit ?? session.limit ?? 0),
      requests: Number(result.requests ?? session.requests ?? 0),
      charLimit: Number(result.charLimit ?? session.charLimit ?? 0),
      characters: Number(result.characters ?? session.characters ?? 0),
      validatedAt: Date.now(),
    };

    await saveLicenseSession(refreshed);
    store.set('license', {
      org: refreshed.org,
      type: refreshed.type,
      limit: refreshed.limit,
      requests: refreshed.requests,
      charLimit: refreshed.charLimit,
      characters: refreshed.characters,
      valid: true,
    });

    return { valid: true, ...refreshed };
  } catch {
    return { valid: true, ...session, stale: true };
  }
});

ipcMain.handle('license:clearSession', async () => {
  await clearLicenseSession();
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

ipcMain.handle('app:getPublicConfig', async () => ({
  licenseApiBaseUrl: LICENSE_API_BASE_URL,
  backendRepo: `${BACKEND_REPO_OWNER}/${BACKEND_REPO_NAME}`,
}));
