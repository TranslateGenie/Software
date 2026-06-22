// Thin S3 adapter for Lambda — no dev mode, no signature verification
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
const bucket = process.env.AWS_S3_BUCKET;
const licensesPath = process.env.LICENSES_PATH || 'licenses.json';

export async function loadLicenses() {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: licensesPath }));
  const body = await res.Body.transformToString();
  const data = JSON.parse(body);
  const etag = res.ETag;
  const json = Array.isArray(data) ? data : (data.licenses || []);
  return { json, etag };
}

export async function saveLicenses(licenses) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: licensesPath,
    Body: JSON.stringify(licenses, null, 2),
    ContentType: 'application/json',
  }));
}
