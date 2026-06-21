import crypto from 'crypto';
import { getJson, putJson } from './s3-storage.js';

const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || '';
const LICENSES_PATH = process.env.LICENSES_PATH || 'licenses.json';
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


async function readBugReports() {
  ensureBucket();
  try {
    const { json } = await getJson(AWS_S3_BUCKET, 'bug-reports.json');
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

export async function listBugReports() {
  return readBugReports();
}

export async function getBugReportById(id) {
  const reports = await readBugReports();
  const report = reports.find((r) => r.id === id);
  if (!report) throw new Error(`Bug report ${id} not found.`);
  return report;
}

export async function saveBugReport(report) {
  ensureBucket();
  const reports = await readBugReports();
  const index = reports.findIndex((r) => r.id === report.id);
  if (index === -1) {
    reports.push(report);
  } else {
    reports[index] = report;
  }
  await putJson(AWS_S3_BUCKET, 'bug-reports.json', reports);
}

export async function loadNews() {
  ensureBucket();
  const { json } = await getJson(AWS_S3_BUCKET, 'news.json');
  return json;
}

export async function loadReviews() {
  ensureBucket();
  const { json } = await getJson(AWS_S3_BUCKET, 'reviews.json');
  return json;
}
