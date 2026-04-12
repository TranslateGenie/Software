import { loadLicenses } from '../lib/github-data.js';

const TIER_DEFAULTS = {
  T1: { limit: 500, charLimit: 10000000 },
  T2: { limit: 2000, charLimit: 40000000 },
  T3: { limit: 10000, charLimit: 200000000 },
};

function decodeBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function buildTokenPayload(record, licenseKey) {
  const normalized = normalizeLicenseRecord(record);
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;
  return {
    token: `mdas_${Buffer.from(`${licenseKey}:${expiresAt}`).toString('base64url')}`,
    valid: true,
    org: normalized.org,
    type: normalized.type,
    requests: normalized.requests,
    limit: normalized.limit,
    characters: normalized.characters,
    charLimit: normalized.charLimit,
    remainingRequests: Math.max(0, normalized.limit - normalized.requests),
    remainingCharacters: Math.max(0, normalized.charLimit - normalized.characters),
    expires_at: expiresAt,
  };
}

function normalizeLicenseRecord(record) {
  const defaults = TIER_DEFAULTS[String(record?.type || '').toUpperCase()] || {};
  return {
    ...record,
    requests: Number(record?.requests ?? 0),
    limit: Number(record?.limit ?? defaults.limit ?? 0),
    characters: Number(record?.characters ?? 0),
    charLimit: Number(record?.charLimit ?? defaults.charLimit ?? 0),
  };
}

function getInvalidReason(record) {
  if (!record) return 'not-found';
  if (!record.valid) return 'inactive';

  const normalized = normalizeLicenseRecord(record);
  const requestExceeded = normalized.requests >= normalized.limit;
  const characterExceeded = normalized.characters >= normalized.charLimit;
  if (requestExceeded || characterExceeded) return 'limit-reached';

  return null;
}

async function findByLicenseKey(licenseKey) {
  const { json: licenses } = await loadLicenses();
  if (!Array.isArray(licenses)) {
    throw new Error('licenses.json must be an array');
  }
  return licenses.find((entry) => entry?.key === licenseKey);
}

export async function validateLicenseHandler(req, res) {
  const { licenseKey } = req.body || {};
  const bearer = decodeBearer(req);

  try {
    if (licenseKey) {
      const record = await findByLicenseKey(licenseKey);
      const invalidReason = getInvalidReason(record);
      if (invalidReason) {
        return res.status(200).json({ valid: false, reason: invalidReason });
      }
      return res.status(200).json(buildTokenPayload(record, licenseKey));
    }

    if (bearer && bearer.startsWith('mdas_')) {
      try {
        const payload = Buffer.from(bearer.slice('mdas_'.length), 'base64url').toString('utf8');
        const [license, expiry] = payload.split(':');
        const record = await findByLicenseKey(license);
        const invalidReason = getInvalidReason(record);
        if (invalidReason || Number(expiry) < Date.now()) {
          return res.status(200).json({ valid: false, reason: invalidReason || 'expired' });
        }
        return res.status(200).json(buildTokenPayload(record, license));
      } catch {
        return res.status(200).json({ valid: false });
      }
    }

    return res.status(400).json({ valid: false, error: 'licenseKey or bearer token required' });
  } catch (error) {
    return res.status(500).json({ valid: false, error: error.message || 'Failed to validate license' });
  }
}
