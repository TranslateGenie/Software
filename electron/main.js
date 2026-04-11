/**
 * main.js — Electron Main Process
 * Creates the browser window and sets up secure IPC channels
 * between the renderer (React UI) and Node.js APIs.
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import Store from 'electron-store';
import { Octokit } from '@octokit/rest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persistent settings store (stored in user data dir, never in repo)
const store = new Store({
  defaults: {
    githubToken: '',
    repoOwner: '',
    repoName: '',
    targetLanguages: ['en', 'zh'],
  },
});

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

  // In dev mode load Vite dev server; in production load built index.html
  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
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
 * Upload a file to /docs-incoming/ in the configured GitHub repository.
 * The renderer passes the file content as a base64 string.
 */
ipcMain.handle('github:uploadFile', async (_event, { fileName, base64Content }) => {
  const { githubToken, repoOwner, repoName } = store.store;
  if (!githubToken || !repoOwner || !repoName) {
    throw new Error('GitHub settings are not configured. Open Settings and fill in all fields.');
  }

  const octokit = new Octokit({ auth: githubToken });
  const repoPath = `docs-incoming/${fileName}`;

  // Check if the file already exists so we can provide the SHA for updates
  let existingSha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path: repoPath,
    });
    existingSha = data.sha;
  } catch {
    // File does not exist yet — that is the normal first-upload case
  }

  await octokit.repos.createOrUpdateFileContents({
    owner: repoOwner,
    repo: repoName,
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
  const { githubToken, repoOwner, repoName } = store.store;
  if (!githubToken || !repoOwner || !repoName) {
    throw new Error('GitHub settings are not configured.');
  }

  const octokit = new Octokit({ auth: githubToken });

  try {
    const { data } = await octokit.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path: `translations/${lang}`,
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
ipcMain.handle('github:downloadFile', async (_event, { repoOwner: owner, repoName: repo, filePath }) => {
  const { githubToken } = store.store;
  if (!githubToken) throw new Error('GitHub token is not configured.');

  const octokit = new Octokit({ auth: githubToken });
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
  });

  return { content: data.content, encoding: data.encoding };
});

/**
 * List files currently in docs-incoming so the UI can show pending items.
 */
ipcMain.handle('github:listIncoming', async () => {
  const { githubToken, repoOwner, repoName } = store.store;
  if (!githubToken || !repoOwner || !repoName) return [];

  const octokit = new Octokit({ auth: githubToken });
  try {
    const { data } = await octokit.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path: 'docs-incoming',
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
