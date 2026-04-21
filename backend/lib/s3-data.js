import crypto from 'crypto';
import {
  getJson,
  putJson,
  uploadFile,
  downloadFile,
  listObjects,
} from '../../express/storage/s3Storage.js';

const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || '';
const LICENSES_PATH = process.env.LICENSES_PATH || 'licenses.json';
const API_KEYS_PATH = process.env.API_KEYS_PATH || 'apiks.json';
const LICENSE_SIGNING_PUBLIC_KEY = process.env.LICENSE_SIGNING_PUBLIC_KEY || '';
const LICENSE_SIGNATURE_REQUIRED = String(process.env.LICENSE_SIGNATURE_REQUIRED || 'false').toLowerCase() === 'true';

function ensureBucket() {
  if (!AWS_S3_BUCKET) {
    throw new Error('AWS_S3_BUCKET is not configured.');
  }
}

function normalizeLicensesPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      licenses: payload,
      signature: null,
      signedAt: null,
    };
  }

  if (payload && typeof payload === 'object' && Array.isArray(payload.licenses)) {
    return {
      licenses: payload.licenses,
      signature: typeof payload.signature === 'string' ? payload.signature : null,
      signedAt: typeof payload.signedAt === 'string' ? payload.signedAt : null,
    };
  }

  throw new Error('licenses.json must be an array or an object containing a licenses array.');
}

function verifyLicensesSignature(licensesPayload) {
  if (!LICENSE_SIGNING_PUBLIC_KEY) {
    if (LICENSE_SIGNATURE_REQUIRED) {
      throw new Error('LICENSE_SIGNING_PUBLIC_KEY is required when LICENSE_SIGNATURE_REQUIRED=true.');
    }
    return { verified: false, reason: 'no-public-key' };
  }

  if (!licensesPayload.signature) {
    if (LICENSE_SIGNATURE_REQUIRED) {
      throw new Error('licenses.json signature is missing while LICENSE_SIGNATURE_REQUIRED=true.');
    }
    return { verified: false, reason: 'no-signature' };
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(JSON.stringify(licensesPayload.licenses), 'utf8');
  verifier.end();

  const valid = verifier.verify(
    LICENSE_SIGNING_PUBLIC_KEY.replace(/\\n/g, '\n'),
    licensesPayload.signature,
    'base64'
  );

  if (!valid) {
    throw new Error('licenses.json signature verification failed.');
  }

  return { verified: true, reason: 'ok' };
}

export async function loadLicenses() {
  ensureBucket();
  const { json, etag } = await getJson(AWS_S3_BUCKET, LICENSES_PATH);
  const normalized = normalizeLicensesPayload(json);
  const signature = verifyLicensesSignature(normalized);
  return {
    json: normalized.licenses,
    etag,
    signature,
    signedAt: normalized.signedAt,
  };
}

export async function saveLicenses(licenses, _etag, _message = '') {
  ensureBucket();
  await putJson(AWS_S3_BUCKET, LICENSES_PATH, licenses);
}

export async function loadApiKeys() {
  ensureBucket();
  return getJson(AWS_S3_BUCKET, API_KEYS_PATH);
}

export function parseApiKeysSchema(apiKeysJson) {
  if (!Array.isArray(apiKeysJson)) {
    throw new Error('apiks.json must be an array.');
  }

  const squareEntry = apiKeysJson.find((item) => item && Object.prototype.hasOwnProperty.call(item, 'Square'));
  const azureEntry = apiKeysJson.find((item) => item && Object.prototype.hasOwnProperty.call(item, 'Azure'));

  const squareKeys = Array.isArray(squareEntry?.Square) ? squareEntry.Square : [];
  const azureKeys = Array.isArray(azureEntry?.Azure) ? azureEntry.Azure : [];

  return {
    squareKeys,
    azureKeys,
  };
}

export async function storeTranslationAssets({
  org,
  translationId,
  targetLanguage,
  fileName,
  inputBuffer,
  outputBuffer,
  metadata,
}) {
  ensureBucket();
  const safeName = String(fileName || 'document.txt');

  const inputKey = `translations/input/${org}/${translationId}/${safeName}`;
  const outputKey = `translations/output/${org}/${targetLanguage}/${translationId}/${safeName}`;
  const metadataKey = `translations/meta/${org}/${targetLanguage}/${translationId}.json`;

  await uploadFile(AWS_S3_BUCKET, inputKey, inputBuffer);
  await uploadFile(AWS_S3_BUCKET, outputKey, outputBuffer);
  await putJson(AWS_S3_BUCKET, metadataKey, {
    id: translationId,
    org,
    targetLanguage,
    fileName: safeName,
    inputKey,
    outputKey,
    createdAt: new Date().toISOString(),
    ...metadata,
  });

  return { inputKey, outputKey, metadataKey };
}

export async function getTranslationMetadata(org, targetLanguage, translationId) {
  ensureBucket();
  const key = `translations/meta/${org}/${targetLanguage}/${translationId}.json`;
  const { json } = await getJson(AWS_S3_BUCKET, key);
  return json;
}

export async function listTranslationsForLanguage(org, targetLanguage) {
  ensureBucket();
  const prefix = `translations/meta/${org}/${targetLanguage}/`;
  const objects = await listObjects(AWS_S3_BUCKET, prefix);

  const metas = await Promise.all(
    objects
      .filter((item) => item.key.endsWith('.json'))
      .map(async (item) => {
        try {
          const { json } = await getJson(AWS_S3_BUCKET, item.key);
          return json;
        } catch {
          return null;
        }
      })
  );

  return metas
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getTranslationFileBuffer(outputKey) {
  ensureBucket();
  const { buffer, contentType } = await downloadFile(AWS_S3_BUCKET, outputKey);
  return { buffer, contentType };
}

export async function listBugReports() {
  ensureBucket();
  const prefix = 'bug-reports/';
  const objects = await listObjects(AWS_S3_BUCKET, prefix);

  const reports = await Promise.all(
    objects
      .filter((item) => item.key.endsWith('.json'))
      .map(async (item) => {
        try {
          const { json } = await getJson(AWS_S3_BUCKET, item.key);
          return json;
        } catch {
          return null;
        }
      })
  );

  return reports
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getBugReportById(id) {
  ensureBucket();
  const key = `bug-reports/${id}.json`;
  const { json } = await getJson(AWS_S3_BUCKET, key);
  return json;
}

export async function saveBugReport(report) {
  ensureBucket();
  const key = `bug-reports/${report.id}.json`;
  await putJson(AWS_S3_BUCKET, key, report);
}
