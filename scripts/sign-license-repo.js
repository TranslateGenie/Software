import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import crypto from 'crypto';

const {
  GITHUB_APP_ID = '',
  GITHUB_APP_INSTALLATION_ID = '',
  GITHUB_APP_PRIVATE_KEY = '',
  LICENSE_REPO_OWNER = '',
  LICENSE_REPO_NAME = '',
  LICENSES_PATH = 'licenses.json',
  LICENSE_SIGNING_PRIVATE_KEY = '',
} = process.env;

function assertEnv(name, value) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
}

function normalizePrivateKey(value) {
  return value.replace(/\\n/g, '\n');
}

function buildSigner() {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: GITHUB_APP_ID,
      installationId: GITHUB_APP_INSTALLATION_ID,
      privateKey: normalizePrivateKey(GITHUB_APP_PRIVATE_KEY),
    },
  });
}

function extractLicenses(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray(payload.licenses)) return payload.licenses;
  throw new Error('licenses.json must be an array or an object containing a licenses array.');
}

function signLicenses(licenses) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(JSON.stringify(licenses), 'utf8');
  signer.end();
  return signer.sign(normalizePrivateKey(LICENSE_SIGNING_PRIVATE_KEY), 'base64');
}

async function main() {
  assertEnv('GITHUB_APP_ID', GITHUB_APP_ID);
  assertEnv('GITHUB_APP_INSTALLATION_ID', GITHUB_APP_INSTALLATION_ID);
  assertEnv('GITHUB_APP_PRIVATE_KEY', GITHUB_APP_PRIVATE_KEY);
  assertEnv('LICENSE_REPO_OWNER', LICENSE_REPO_OWNER);
  assertEnv('LICENSE_REPO_NAME', LICENSE_REPO_NAME);
  assertEnv('LICENSE_SIGNING_PRIVATE_KEY', LICENSE_SIGNING_PRIVATE_KEY);

  const octokit = buildSigner();

  const { data } = await octokit.repos.getContent({
    owner: LICENSE_REPO_OWNER,
    repo: LICENSE_REPO_NAME,
    path: LICENSES_PATH,
  });

  if (Array.isArray(data) || !data.content) {
    throw new Error(`Expected file content at ${LICENSE_REPO_OWNER}/${LICENSE_REPO_NAME}:${LICENSES_PATH}`);
  }

  const decoded = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);
  const licenses = extractLicenses(parsed);

  const signedPayload = {
    licenses,
    signature: signLicenses(licenses),
    signedAt: new Date().toISOString(),
    algorithm: 'RSA-SHA256',
  };

  const nextContent = Buffer.from(`${JSON.stringify(signedPayload, null, 2)}\n`, 'utf8').toString('base64');

  await octokit.repos.createOrUpdateFileContents({
    owner: LICENSE_REPO_OWNER,
    repo: LICENSE_REPO_NAME,
    path: LICENSES_PATH,
    message: 'chore: refresh license signature [skip ci]',
    content: nextContent,
    sha: data.sha,
  });

  console.log(`Updated signed licenses payload at ${LICENSE_REPO_OWNER}/${LICENSE_REPO_NAME}:${LICENSES_PATH}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
