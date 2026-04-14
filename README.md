# Translate Genie

The only software you need for going from one language to another seamlessly. Translate office documents with zero infrastructure setup. Upload from desktop, download a few moments later. It really is THAT easy! Completely private and secure, empowered entirely with Azure AI. Simply purchase a license, download the desktop app, and start translating your documents today. No more copy-pasting or manual translation work. Translate Genie is your one-stop solution for all your document translation needs. With multiple pricing tiers to choose from, you can select the plan that best fits your organization's needs.

## Runtime Architecture

- Electron desktop app starts and manages a local Express helper process.
- The local helper handles license/API orchestration through local HTTP endpoints.
- Azure and Square secrets should remain outside the desktop runtime.

## v1 Security Hardening

See [docs/security-v1.md](docs/security-v1.md) for:

- GitHub App least-privilege scope checklist
- Lightweight license signature verification model
- Signing workflow and required secrets
- Key-rotation runbook
- CI security workflows

## User Journey: Landing Page to First Translation

1. Visit the website landing page and review product details and supported formats.
2. Open the pricing page and choose the appropriate license tier.
3. Complete checkout and receive your license key.
4. Go to the download page and install the desktop app.
5. Launch the app. It starts a local Express helper service automatically.
6. Enter your license key on first launch. The app validates and caches it securely for future launches.
7. Open the Upload view and drag in a document (PDF, DOCX, PPTX, or XLSX).
8. Click Upload. The app sends files to the incoming queue and triggers translation workflow processing.
9. Open the Translations view and refresh until your translated file appears.
10. Download the translated file to your local machine.

### First-Run Notes

- You only need to enter the license key once unless it is revoked or cleared.
- Remaining request and character quotas are shown in-app before upload.
- If quotas are near limits, the app shows warnings and prompts renewal.
