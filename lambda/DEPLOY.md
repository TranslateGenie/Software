# Lambda Deployment Guide

Two Lambda functions power the public purchase flow. Both read/write `licenses.json` in your existing S3 bucket.

---

## 1. Package the functions

Run from the `lambda/` directory (PowerShell):

```powershell
.\package-lambdas.ps1
```

This produces:
- `lambda/dist/create-checkout.zip`
- `lambda/dist/square-webhook.zip`

---

## 2. Create the Lambda functions in AWS Console

For **each** zip:

1. **Lambda → Create function → Author from scratch**
   - Name: `tg-create-checkout` / `tg-square-webhook`
   - Runtime: **Node.js 20.x**
   - Architecture: x86_64
2. **Upload the zip** under "Code source → Upload from → .zip file"
3. **Handler**: `index.handler`
4. **Environment variables** (Configuration → Environment variables):

| Key | Value |
|-----|-------|
| `AWS_S3_BUCKET` | `translate-genie-json` |
| `LICENSES_PATH` | `licenses.json` |
| `SQUARE_ACCESS_TOKEN` | *(from your .env)* |
| `SITE_URL` | `https://translategenie.github.io` |
| `ALLOWED_ORIGIN` | `https://translategenie.github.io` |

> `AWS_REGION` is set automatically by Lambda. No AWS key/secret needed — use an IAM role instead (see step 3).

5. **Timeout**: 15 seconds (Configuration → General configuration)

---

## 3. IAM role — grant S3 access

Lambda needs to read and write your S3 bucket. Either attach a policy to the function's execution role, or create a dedicated role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::translate-genie-json/*"
    }
  ]
}
```

Attach this to the execution role Lambda created (or assign it at creation time).

---

## 4. Create an API Gateway (HTTP API)

1. **API Gateway → Create API → HTTP API**
2. Add integrations:
   - `POST /api/create-checkout` → `tg-create-checkout` Lambda
   - `POST /api/square-webhook` → `tg-square-webhook` Lambda
3. Enable **CORS** on the API:
   - Allowed origins: `https://translategenie.github.io`
   - Allowed methods: `POST, OPTIONS`
   - Allowed headers: `Content-Type`
4. Deploy to a stage (e.g., `prod`)
5. Copy the **Invoke URL** — it looks like:
   `https://abc1234xyz.execute-api.us-east-2.amazonaws.com/prod`

---

## 5. Wire up checkout.html on GitHub Pages

In the GitHub Pages version of `checkout.html`, add this **before** the closing `</head>`:

```html
<script>window.TG_API_BASE = 'https://abc1234xyz.execute-api.us-east-2.amazonaws.com/prod';</script>
```

Replace the URL with your actual API Gateway invoke URL.

---

## 6. Set Square webhook URL

In your Square Developer Dashboard:
- **Webhooks → Add endpoint**
- URL: `https://abc1234xyz.execute-api.us-east-2.amazonaws.com/prod/api/square-webhook`
- Events to subscribe: `payment.updated`

---

## 7. Add license.html to GitHub Pages

Copy `backend/web/license-delivery.html` to your GitHub Pages repo as `license.html`. Square will redirect buyers there after payment.
