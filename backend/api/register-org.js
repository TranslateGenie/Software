import { loadLicenses, saveLicenses } from '../lib/github-data.js';

const TIER_CONFIG = {
  T1: { userRange: '1-20', requestLimit: 500, charLimit: 10000000 },
  T2: { userRange: '21-100', requestLimit: 2000, charLimit: 40000000 },
  T3: { userRange: '100+', requestLimit: 10000, charLimit: 200000000 },
};

function resolveTierByUserCount(userCount) {
  const count = Number(userCount);
  if (!Number.isFinite(count) || count < 1) return null;
  if (count <= 20) return 'T1';
  if (count <= 100) return 'T2';
  return 'T3';
}

function generateLicenseKey(org) {
  const root = (org || 'ORG').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4) || 'MDAS';
  const rand = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${root}-${rand()}-${rand()}-${rand()}`;
}

export async function registerOrgHandler(req, res) {
  const { org, type = 'T1', userCount } = req.body || {};

  if (!org) {
    return res.status(400).json({ ok: false, error: 'org is required' });
  }

  const normalizedType = String(type || '').toUpperCase();
  const tierType = resolveTierByUserCount(userCount) || normalizedType;
  const tier = TIER_CONFIG[tierType];

  if (!tier) {
    return res.status(400).json({
      ok: false,
      error: 'type must be one of T1, T2, T3 (or provide valid userCount).',
    });
  }

  try {
    const { json: licenses, sha } = await loadLicenses();
    if (!Array.isArray(licenses)) {
      return res.status(500).json({ ok: false, error: 'licenses.json must be an array' });
    }

    const key = generateLicenseKey(org);
    const newRecord = {
      org,
      type: tierType,
      requests: 0,
      limit: tier.requestLimit,
      characters: 0,
      charLimit: tier.charLimit,
      key,
      valid: true,
    };

    licenses.push(newRecord);
    await saveLicenses(licenses, sha, `chore: register org ${org} [skip ci]`);

    return res.status(201).json({
      ok: true,
      license: newRecord,
      tier: {
        code: tierType,
        user_range: tier.userRange,
        request_limit: tier.requestLimit,
        character_limit: tier.charLimit,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to register org' });
  }
}
