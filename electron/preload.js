/**
 * preload.js — Electron Preload Script
 *
 * Runs in a privileged context before the renderer page loads.
 * Exposes a minimal, safe API surface to the renderer via contextBridge
 * so the React UI never needs direct access to Node.js APIs.
 */

import { contextBridge, ipcRenderer } from 'electron';

/**
 * `window.mdas` — the only object exposed to the renderer.
 * All methods return Promises and route through IPC to main.js.
 */
contextBridge.exposeInMainWorld('mdas', {
  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  // ── File system ───────────────────────────────────────────────────────────
  saveFileDialog: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  writeFile: (filePath, base64Data) => ipcRenderer.invoke('fs:writeFile', filePath, base64Data),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),

  // ── GitHub ────────────────────────────────────────────────────────────────
  uploadFile: (payload) => ipcRenderer.invoke('github:uploadFile', payload),
  listTranslations: (lang) => ipcRenderer.invoke('github:listTranslations', lang),
  downloadFile: (payload) => ipcRenderer.invoke('github:downloadFile', payload),
  listIncoming: () => ipcRenderer.invoke('github:listIncoming'),
});
