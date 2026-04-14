# Translate Genie

The only software you need for going from one language to another seamlessly. Translate office documents with zero infrastructure setup. Upload from desktop, download a few moments later. It really is THAT easy! Completely private and secure, empowered entirely with Azure AI. Simply purchase a license, download the desktop app, and start translating your documents today. No more copy-pasting or manual translation work. Translate Genie is your one-stop solution for all your document translation needs. With multiple pricing tiers to choose from, you can select the plan that best fits your organization's needs.

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

## Development

### Local Setup

```bash
# Install all dependencies
npm install
npm install --prefix electron
npm install --prefix backend

# Run development server
npm run backend:dev

# Run Electron dev (from electron directory)
npm run dev --prefix electron
```

### Building for Release

To create a release:

```bash
# Create and push a semantic version tag
git tag v1.0.0
git push origin v1.0.0
```

The GitHub Actions workflow will automatically:
- Build the Electron app
- Create a GitHub Release
- Upload the signed installer
- Make it available for download

For detailed release instructions, see [.github/RELEASE_WORKFLOW.md](.github/RELEASE_WORKFLOW.md).

## Architecture

- **Website**: Static HTML/CSS deployed to GitHub Pages (no backend server)
	- Marketing, pricing, license delivery, download pages
- **Electron App**: Desktop application with embedded Express server
	- License activation, document upload, translation management
- **GitHub Actions**: Automated pipelines for
	- Website deployment
	- Document translation processing
	- License data signing
	- Security checks and audits
	- Installer build and release
- **Square Webhooks**: License creation and updates
