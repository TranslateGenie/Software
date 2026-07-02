/**
 * preload.js — Electron Preload Script
 *
 * Runs in a privileged context before the renderer page loads.
 * Exposes a minimal, safe API surface to the renderer via contextBridge
 * so the React UI never needs direct access to Node.js APIs.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * `window.mdas` — the only object exposed to the renderer.
 * All methods return Promises and route through IPC to main.js.
 */
contextBridge.exposeInMainWorld('mdas', {
  // ── Licensing ─────────────────────────────────────────────────────────────
  validateLicenseKey: (licenseKey) => ipcRenderer.invoke('license:validateKey', licenseKey),
  getLicenseSession: () => ipcRenderer.invoke('license:getSession'),
  refreshLicenseSession: () => ipcRenderer.invoke('license:refreshSession'),
  clearLicenseSession: () => ipcRenderer.invoke('license:clearSession'),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  // ── File system ───────────────────────────────────────────────────────────
  saveFileDialog: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  writeFile: (filePath, base64Data) => ipcRenderer.invoke('fs:writeFile', filePath, base64Data),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  openPricingPage: () => ipcRenderer.invoke('app:openPricingPage'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ── Translation APIs ──────────────────────────────────────────────────────
  uploadFile: (payload) => ipcRenderer.invoke('translation:uploadFile', payload),
  listTranslations: (lang) => ipcRenderer.invoke('translation:listTranslations', lang),
  clearTranslations: (lang) => ipcRenderer.invoke('translation:clearTranslations', lang),
  downloadFile: (payload) => ipcRenderer.invoke('translation:downloadFile', payload),
  reformatWithAI: (payload) => ipcRenderer.invoke('translation:reformatWithAI', payload),
  polishLanguage: (payload) => ipcRenderer.invoke('translation:polishLanguage', payload),
  openStorageFolder: (lang) => ipcRenderer.invoke('translation:openStorageFolder', lang),
  listIncoming: () => ipcRenderer.invoke('translation:listPending'),

  // ── Bug reports ───────────────────────────────────────────────────────────
  listBugReports: (payload) => ipcRenderer.invoke('bugReports:list', payload),
  getBugReport: (id) => ipcRenderer.invoke('bugReports:get', id),
  createBugReport: (payload) => ipcRenderer.invoke('bugReports:create', payload),
  addBugReportComment: (payload) => ipcRenderer.invoke('bugReports:addComment', payload),
  updateBugReportStatus: (payload) => ipcRenderer.invoke('bugReports:updateStatus', payload),
  updateBugReportDetails: (payload) => ipcRenderer.invoke('bugReports:updateDetails', payload),

  // ── Admin mode ────────────────────────────────────────────────────────────
  adminLogin: (password) => ipcRenderer.invoke('admin:login', password),
  adminLogout: () => ipcRenderer.invoke('admin:logout'),
  isAdminUnlocked: () => ipcRenderer.invoke('admin:isUnlocked'),

  // ── Metadata ──────────────────────────────────────────────────────────────
  getPublicConfig: () => ipcRenderer.invoke('app:getPublicConfig'),

  // ── Updates ───────────────────────────────────────────────────────────────
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  onUpdateStatus: (callback) => ipcRenderer.on('app:updateStatus', (_e, data) => callback(data)),
  removeUpdateStatusListener: () => ipcRenderer.removeAllListeners('app:updateStatus'),
});
