# MDAS — Multilingual Document Automation System

A complete system for drag-and-drop document translation powered by an **Electron desktop app**, **GitHub Actions**, and the **Azure AI Translator API**.

---

## System Overview

```
User (Electron App)
  │  drag-and-drop DOCX / PPTX / XLSX / PDF
  ▼
docs-incoming/          ← Electron uploads files here via GitHub API
  │
  ▼ (GitHub Actions trigger)
scripts/translate-docs.js
  │  ├─ Extracts text from documents
  │  ├─ Calls Azure AI Translator
  │  └─ Rebuilds translated documents
  ▼
translations/
  ├─ en/                ← English output
  ├─ zh/                ← Chinese output
  └─ third/             ← Third language output
docs-processed/         ← Original files moved here after translation
  │
  ▼ (Electron polls for results)
User downloads translated files
```

---

## Repository Structure

```
root/
├─ electron/
│  ├─ main.js               Electron main process (window + IPC + GitHub API)
│  ├─ preload.js             Secure contextBridge API surface for renderer
│  ├─ vite.config.js         Vite configuration for the React renderer
│  ├─ package.json           Electron app dependencies
│  └─ renderer/
│     ├─ index.html
│     ├─ index.jsx            React entry point
│     ├─ App.jsx              Root component (navigation)
│     ├─ styles.css           Global styles
│     └─ components/
│        ├─ DropZone.jsx      Drag-and-drop file input
│        ├─ FileList.jsx      Queued file list with status indicators
│        ├─ UploadView.jsx    Main upload screen
│        ├─ TranslationsView.jsx  Browse & download translated files
│        ├─ SettingsView.jsx  GitHub & language settings
│        └─ StatusBar.jsx     Bottom status bar
│
├─ scripts/
│  └─ translate-docs.js      GitHub Actions translation pipeline script
│
├─ docs-incoming/            Upload target (Electron → GitHub)
├─ docs-processed/           Originals moved here post-translation
├─ translations/
│  ├─ en/
│  ├─ zh/
│  └─ third/
│
├─ .github/
│  └─ workflows/
│     └─ translate-docs.yml  Triggered on push to docs-incoming/**
│
├─ package.json              Root (script dependencies for translate-docs.js)
└─ README.md
```

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/<your-org>/<your-repo>.git
cd <your-repo>
```

### 2. Configure GitHub Secrets

In your GitHub repository go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `AZURE_TRANSLATOR_KEY` | Your Azure Cognitive Services subscription key |
| `AZURE_TRANSLATOR_ENDPOINT` | e.g. `https://api.cognitive.microsofttranslator.com` |
| `AZURE_TRANSLATOR_REGION` | e.g. `eastus` |

### 3. Set target languages (optional)

In **Settings → Variables → Actions** add a repository variable:

| Variable | Example |
|----------|---------|
| `TARGET_LANGUAGES` | `en,zh,es,fr` |

### 4. Install and run the Electron app

```bash
cd electron
npm install
npm start
```

On first run, go to the **Settings** tab and enter:
- Your GitHub Personal Access Token (needs `repo` scope)
- Repository owner and name

### 5. Upload a document

1. Switch to the **Upload** tab
2. Drag-and-drop or click to select DOCX/PPTX/XLSX/PDF files
3. Click **Upload**
4. GitHub Actions will automatically translate them
5. Switch to the **Translations** tab and click **↻ Refresh** or wait for auto-poll

---

## Supported File Formats

| Format | Text Extraction | Rebuild |
|--------|----------------|---------|
| DOCX | `word/document.xml` — `<w:t>` nodes | Repacked ZIP |
| PPTX | `ppt/slides/slideN.xml` — `<a:t>` runs | Repacked ZIP |
| XLSX | `xl/sharedStrings.xml` — `<t>` elements | Repacked ZIP |
| PDF | Full text extraction via `pdf-parse` | Plain-text `.txt` |

---

## Architecture Details

### Electron App

- **main.js** — Creates the `BrowserWindow`, exposes IPC handlers for settings, file I/O, and GitHub API calls using `@octokit/rest`. Secrets (GitHub token) are stored in the OS keychain via `electron-store`, never in the repository.
- **preload.js** — Bridges the main process API to the renderer via `contextBridge` with `contextIsolation: true` and `nodeIntegration: false`.
- **React renderer** — Built with Vite + React 18. Views: Upload, Translations, Settings.

### GitHub Actions

- Triggers on `push` to `docs-incoming/**`
- Detects newly added files with `git diff`
- Runs `scripts/translate-docs.js` with Azure secrets injected as environment variables
- Commits translated outputs and pushes back to the repository with `[skip ci]`

### Translation Script

- Uses the Azure Translator v3 REST API
- Batches text in chunks of 50 strings to avoid request size limits
- Processes each document format independently (DOCX/PPTX/XLSX/PDF)
- Moves originals to `docs-processed/` after successful translation

---

## Development

```bash
# Run Electron in development mode (hot-reload via Vite)
cd electron
npm install
npm run dev

# Install translation script dependencies
npm install   # from repo root

# Run translation script locally (requires Azure env vars)
AZURE_TRANSLATOR_KEY=xxx \
AZURE_TRANSLATOR_REGION=eastus \
INCOMING_FILES="docs-incoming/test.docx" \
node scripts/translate-docs.js
```

---

## Security Notes

- GitHub tokens and Azure keys are **never stored in the repository**.
- The Electron renderer runs with `contextIsolation: true` and `nodeIntegration: false`.
- All sensitive settings are stored in the OS user data directory via `electron-store`.
- The GitHub Actions workflow uses the minimum required permissions (`contents: write`).

---

## Future / Roadmap

- [ ] Subscription system with managed Azure API credits
- [ ] OCR support for scanned PDFs
- [ ] Full PDF rebuilding (preserving layout)
- [ ] Support for additional file formats (ODT, RTF)
- [ ] Per-document translation history
- [ ] Progress notifications via GitHub webhook
