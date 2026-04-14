import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import crypto from 'crypto';

const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '';
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '';
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '';

const LICENSE_REPO_OWNER = process.env.LICENSE_REPO_OWNER || '';
const LICENSE_REPO_NAME = process.env.LICENSE_REPO_NAME || '';
const LICENSES_PATH = process.env.LICENSES_PATH || 'licenses.json';
const API_KEYS_PATH = process.env.API_KEYS_PATH || 'apiks.json';
const LICENSE_SIGNING_PUBLIC_KEY = process.env.LICENSE_SIGNING_PUBLIC_KEY || '';
const LICENSE_SIGNATURE_REQUIRED = String(process.env.LICENSE_SIGNATURE_REQUIRED || 'false').toLowerCase() === 'true';

function getPrivateKey() {
  if (!GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not configured.');
  }
  return GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
}

function ensureGithubConfig() {
  if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID) {
    throw new Error('GitHub App credentials are incomplete.');
  }
  if (!LICENSE_REPO_OWNER || !LICENSE_REPO_NAME) {
    throw new Error('License repository owner/name are not configured.');
  }
}

export async function getOctokit() {
  ensureGithubConfig();
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: GITHUB_APP_ID,
      installationId: GITHUB_APP_INSTALLATION_ID,
      privateKey: getPrivateKey(),
    },
  });
}

function normalizeGitHubError(error) {
  const message = String(error?.message || '');
  if (message.includes('create-an-installation-access-token-for-an-app')) {
    return new Error(
      'GitHub App installation token request failed (404). Check GITHUB_APP_INSTALLATION_ID, ensure the app is installed on LICENSE_REPO_OWNER/LICENSE_REPO_NAME, and verify the private key belongs to that same app.'
    );
  }
  if (message.includes('Resource not accessible by integration')) {
    return new Error(
      'GitHub App can authenticate but lacks repository access/permissions. Install the app on LICENSE_REPO_OWNER/LICENSE_REPO_NAME and grant Repository permissions: Contents (Read and write), Metadata (Read-only). Then re-install or update app permissions for the installation.'
    );
  }
  return error;
}

async function getJsonFile(path) {
  try {
    const octokit = await getOctokit();
    const { data } = await octokit.repos.getContent({
      owner: LICENSE_REPO_OWNER,
      repo: LICENSE_REPO_NAME,
      path,
    });

    if (Array.isArray(data) || !data.content) {
      throw new Error(`Expected file content at ${path}`);
    }

    const decoded = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
    return {
      json: JSON.parse(decoded),
      sha: data.sha,
    };
  } catch (error) {
    throw normalizeGitHubError(error);
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

async function writeJsonFile(path, json, sha, message) {
  const octokit = await getOctokit();
  await octokit.repos.createOrUpdateFileContents({
    owner: LICENSE_REPO_OWNER,
    repo: LICENSE_REPO_NAME,
    path,
    message,
    content: Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8').toString('base64'),
    sha,
  });
}

export async function loadLicenses() {
  const { json, sha } = await getJsonFile(LICENSES_PATH);
  const normalized = normalizeLicensesPayload(json);
  const signature = verifyLicensesSignature(normalized);
  return {
    json: normalized.licenses,
    sha,
    signature,
    signedAt: normalized.signedAt,
  };
}

export async function saveLicenses(licenses, sha, message = 'chore: update licenses usage [skip ci]') {
  return writeJsonFile(LICENSES_PATH, licenses, sha, message);
}

export async function loadApiKeys() {
  return getJsonFile(API_KEYS_PATH);
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