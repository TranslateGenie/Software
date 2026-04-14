# Build & Release Workflow

This workflow automatically builds and releases the MDAS Electron application.

## How to Release

### Automatic Release (Recommended)
1. Create a git tag with semantic versioning:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
2. The workflow will automatically:
   - Build the Electron app
   - Create a GitHub Release
   - Upload the installer as a release asset
   - Make it available for download

### Manual Release
1. Go to **Actions** → **Build & Release Electron App**
2. Click **Run workflow**
3. Enter a version string (e.g., `v1.0.1`)
4. The workflow creates a pre-release with that version

## Installer Download URL

After a successful release, the installer is available at:
```
https://github.com/{owner}/{repo}/releases/download/{tag}/mdas-installer.exe
```

The [download-installer.js](../backend/api/download-installer.js) endpoint will return this URL to clients.

## Code Signing (Optional but Recommended)

To add code signing for Windows:

1. **Obtain a code signing certificate** (.pfx file)
2. **Encode it as base64**:
   ```bash
   certutil -encode cert.pfx cert.b64
   ```
3. **Add GitHub Secrets**:
   - `WINDOWS_CERT_B64`: The base64-encoded certificate
   - `WINDOWS_CERT_PASSWORD`: The certificate password

4. **Uncomment the signing step** in [build-release.yml](build-release.yml)

Once configured, installers will be automatically signed on each release.

## Workflow Triggers

| Event | Behavior |
|-------|----------|
| Push tag `v*` | Creates release, builds, signs, uploads |
| Manual dispatch | Creates pre-release with specified version |

## Troubleshooting

### No .exe files found
- Ensure `npm run build --prefix electron` succeeds locally
- Check that electron-builder is properly configured in `electron/package.json`

### Release upload fails
- Ensure the repository has **write** permissions (Settings → Actions → General → Workflow permissions)
- Check that `gh` CLI has access to `GITHUB_TOKEN`

### Installer not available for download
- Verify the release was created by checking **Releases** page
- Check the release assets match the expected filename

## Environment Variables

- `INSTALLER_URL`: Set during build; used by `/api/download-installer` endpoint
- Available in release deployments as `https://github.com/.../releases/download/.../mdas-installer.exe`
