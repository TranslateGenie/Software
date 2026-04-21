# Translate Genie v1 Security Model

## Scope and Goals
This document defines practical v1 hardening for the Electron + local Express architecture.

## What Stays Out of Desktop App
- Azure Translator secrets
- Square secrets and webhook signing secrets

## AWS Scope (Desktop Helper)
Use a dedicated AWS IAM principal with least privilege.

Recommended:
- Scope access to a single S3 bucket used by Translate Genie data
- Allow only required actions:
  - `s3:GetObject`
  - `s3:PutObject`
  - `s3:DeleteObject`
  - `s3:ListBucket`
- Restrict key prefixes if possible:
  - `licenses.json`
  - `apiks.json`
  - `translations/*`
  - `bug-reports/*`
- Deny all other AWS service actions

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

## Data Storage
All persistent state is in AWS S3:
- `licenses.json`
- `apiks.json`
- `translations/input/*`
- `translations/output/*`
- `translations/meta/*`
- `bug-reports/*`

S3 runtime configuration:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `AWS_S3_BUCKET`

## Key Rotation Runbook (Fast Path)
1. Rotate AWS IAM access key used by the local helper runtime.
2. Update runtime/deploy env with new `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
3. If license signing is enabled, rotate signing keys.
4. Update desktop `LICENSE_SIGNING_PUBLIC_KEY` to matching public key.
5. Confirm helper validation succeeds against S3-backed `licenses.json`.

## Baseline CI Guardrails
Workflow:
- `.github/workflows/security-checks.yml`

Checks:
- Dependency Review on PRs
- Gitleaks secret scan
- npm production dependency audit for backend/electron
