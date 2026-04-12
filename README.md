# MDAS SaaS - Multilingual Document Automation System

MDAS is a SaaS translation product with a desktop client and developer-managed backend infrastructure.

## Architecture

- Electron desktop app for end users
- Developer-owned GitHub App for repository access
- Developer-owned translation repository for file storage and automation
- Developer-owned license repository for license records and API key storage
- GitHub Actions for translation and cleanup workflows
- Azure Translator used only in workflows
- Backend licensing API for activation and plan enforcement
- Installer website for registration and download

Users do not configure GitHub, Azure, or personal access tokens.

## Repository Layout

- electron: Desktop app (main process, preload bridge, React renderer)
- scripts/translate-docs.js: Translation pipeline logic
- .github/workflows/translate-docs.yml: Translation automation
- .github/workflows/cleanup.yml: Daily cleanup automation
- backend: Licensing API and installer website
- incoming, processed, translations: Storage structure used by automation

## Electron Client Flow

1. First launch shows Enter License Key.
2. App calls backend /api/validate-license.
3. Backend returns valid, org, type, limit, requests, and token.
4. App stores signed session token in OS keychain via keytar.
5. App uploads files to incoming/<org> using GitHub App installation auth.
6. App polls translations/<org>/<lang> and downloads completed files.

## Environment Variables

### Electron runtime

- LICENSE_API_BASE_URL
- GITHUB_BACKEND_OWNER
- GITHUB_BACKEND_REPO
- GITHUB_APP_ID
- GITHUB_APP_INSTALLATION_ID
- GITHUB_APP_PRIVATE_KEY

Note: keep all secrets outside the repository (CI secrets, build secrets, or OS secret manager).

### GitHub Actions translation workflow

- GITHUB_APP_ID
- GITHUB_APP_INSTALLATION_ID
- GITHUB_APP_PRIVATE_KEY
- LICENSE_REPO_OWNER
- LICENSE_REPO_NAME
- AZURE_TRANSLATOR_ENDPOINT
- AZURE_TRANSLATOR_REGION
- TARGET_LANGUAGES (optional)

License repo file schemas:

- licenses.json: array of { org, type, requests, limit, key, valid }
- apiks.json: [ { "Square": [] }, { "Azure": [] } ]

## Backend API Endpoints

- POST /api/validate-license
- POST /api/register-org
- GET /api/download-installer
- POST /api/square-webhook

Website pages:

- /
- /pricing
- /register
- /license
- /download

## Local Development

### 1. Install dependencies

- Root: npm install
- Electron: cd electron && npm install
- Backend: cd backend && npm install

### 2. Run backend API

- npm run backend:dev

### 3. Run desktop app

- npm run dev --prefix electron

### 4. Build desktop app

- npm run build --prefix electron

## Security Rules

- Never store license keys or signed tokens in plaintext files.
- Never expose GitHub App private key in source control.
- Never ask users for PATs or cloud credentials.
- Keep Azure and GitHub secrets in developer-owned infrastructure only.

## Notes

The backend and licensing logic in this repository are scaffold implementations for product integration. Production deployment should add hardened auth, persistent data storage, payment integration, audit logging, and key rotation.
