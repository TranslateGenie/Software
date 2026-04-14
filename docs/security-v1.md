# Translate Genie v1 Security Model

## Scope and Goals
This document defines practical v1 hardening for the Electron + local Express architecture.

## What Stays Out of Desktop App
- Azure Translator secrets
- Square secrets and webhook signing secrets

## GitHub App Scope (Desktop)
Use a dedicated GitHub App with minimal permissions.

Recommended:
- Install on only the license repository
- Permissions:
  - Repository metadata: Read-only
  - Repository contents: Read and Write
- No org-wide permissions
- No extra repo scopes

## Lightweight License Integrity Check
The local helper can verify license data integrity if `licenses.json` includes a signature envelope.

Supported `licenses.json` formats:
1. Legacy array (no signature)
2. Signed envelope:

```json
{
  "licenses": [
    { "key": "MDAS-...", "org": "acme", "type": "T1", "valid": true }
  ],
  "signature": "<base64-signature>",
  "signedAt": "2026-04-14T00:00:00.000Z",
  "algorithm": "RSA-SHA256"
}
```

Verification behavior is controlled by:
- `LICENSE_SIGNING_PUBLIC_KEY`
- `LICENSE_SIGNATURE_REQUIRED` (`true` or `false`)

Modes:
- If `LICENSE_SIGNATURE_REQUIRED=false` (default), legacy unsigned data still works.
- If `LICENSE_SIGNATURE_REQUIRED=true`, missing/invalid signature fails license reads.

## Signing Automation
Workflow:
- `.github/workflows/sign-license-repo.yml`

Script:
- `scripts/sign-license-repo.js`

It reads `licenses.json` from private repo and writes back a signed envelope.

Required secrets:
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `LICENSE_SIGNING_PRIVATE_KEY`

Required vars:
- `LICENSE_REPO_OWNER`
- `LICENSE_REPO_NAME`
- Optional: `LICENSES_PATH`

## Key Rotation Runbook (Fast Path)
1. Rotate GitHub App private key in GitHub App settings.
2. Update runtime/deploy env with new `GITHUB_APP_PRIVATE_KEY`.
3. Rotate `LICENSE_SIGNING_PRIVATE_KEY` secret.
4. Update desktop `LICENSE_SIGNING_PUBLIC_KEY` to matching public key.
5. Manually run `Sign License Repo Data` workflow once.
6. Confirm helper validation succeeds.

## Baseline CI Guardrails
Workflow:
- `.github/workflows/security-checks.yml`

Checks:
- Dependency Review on PRs
- Gitleaks secret scan
- npm production dependency audit for backend/electron
