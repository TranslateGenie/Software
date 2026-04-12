import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

const GITHUB_APP_ID = process.env.GITHUB_APP_ID || '';
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || '';
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '';

const LICENSE_REPO_OWNER = process.env.LICENSE_REPO_OWNER || '';
const LICENSE_REPO_NAME = process.env.LICENSE_REPO_NAME || '';
const LICENSES_PATH = process.env.LICENSES_PATH || 'licenses.json';
const API_KEYS_PATH = process.env.API_KEYS_PATH || 'apiks.json';

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

async function getJsonFile(path) {
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
  return getJsonFile(LICENSES_PATH);
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