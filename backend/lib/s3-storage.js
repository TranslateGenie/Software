import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

let _s3Client = null;

function getS3Client() {
  if (!_s3Client) {
    const region = process.env.AWS_REGION || '';
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !region) {
      throw new Error('AWS S3 credentials are incomplete. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION.');
    }
    _s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3Client;
}

function ensureS3Config() {
  getS3Client(); // throws if credentials are missing
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function uploadFile(bucket, key, buffer, contentType = 'application/octet-stream') {
  ensureS3Config();
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return { bucket, key };
}

export async function downloadFile(bucket, key) {
  ensureS3Config();
  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  if (!response.Body) {
    throw new Error(`S3 object has no body: ${key}`);
  }

  const buffer = await streamToBuffer(response.Body);
  return {
    bucket,
    key,
    buffer,
    contentType: response.ContentType || 'application/octet-stream',
    etag: response.ETag || null,
  };
}

export async function putJson(bucket, key, json) {
  const buffer = Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8');
  return uploadFile(bucket, key, buffer, 'application/json');
}

export async function getJson(bucket, key) {
  const { buffer, etag } = await downloadFile(bucket, key);
  return {
    json: JSON.parse(buffer.toString('utf8')),
    etag,
  };
}

export async function listObjects(bucket, prefix) {
  ensureS3Config();
  const response = await getS3Client().send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    })
  );

  return (response.Contents || []).map((item) => ({
    key: item.Key,
    size: item.Size,
    lastModified: item.LastModified ? item.LastModified.toISOString() : null,
    etag: item.ETag || null,
  }));
}

export async function deleteObject(bucket, key) {
  ensureS3Config();
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
  return { bucket, key };
}
