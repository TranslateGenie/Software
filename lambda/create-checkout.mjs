import { randomUUID } from 'node:crypto';
import { loadLicenses, saveLicenses } from './storage.mjs';

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';

const PACK_CONFIG = {
  'one-wish':   { amountCents: 1000,   requests: 10,    characters: 200000,    displayName: 'One Wish',        tier: 'T1' },
  'starter':    { amountCents: 9900,   requests: 100,   characters: 2000000,   displayName: 'Two Wishes',      tier: 'T1' },
  'small':      { amountCents: 35000,  requests: 500,   characters: 10000000,  displayName: 'Three Wishes',    tier: 'T1' },
  'medium':     { amountCents: 125000, requests: 2000,  characters: 40000000,  displayName: 'Genie Sidekick',  tier: 'T2' },
  'enterprise': { amountCents: 500000, requests: 10000, characters: 200000000, displayName: 'Genie Companion', tier: 'T3' },
};

function generateLicenseKey(org) {
  const root = (org || 'TGEN').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4) || 'TGEN';
  const rand = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${root}-${rand()}-${rand()}-${rand()}`;
}

function squareHeaders() {
  return {
    'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    'Square-Version': SQUARE_VERSION,
  };
}

let cachedLocationId = null;

async function getDefaultLocationId() {
  if (cachedLocationId) return cachedLocationId;
  const res = await fetch(`${SQUARE_API}/locations`, { headers: squareHeaders() });
  const data = await res.json();
  const active = (data.locations || []).filter(l => l.status === 'ACTIVE');
  if (!active.length) throw new Error('No active Square locations found');
  cachedLocationId = active[0].id;
  return cachedLocationId;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  let org, pack;
  try {
    const body = JSON.parse(event.body || '{}');
    org = body.org;
    pack = body.pack;
  } catch {
    return respond(400, { ok: false, error: 'Invalid JSON body' });
  }

  if (!org || !pack) {
    return respond(400, { ok: false, error: 'org and pack are required' });
  }

  const config = PACK_CONFIG[pack];
  if (!config) {
    return respond(400, { ok: false, error: `Unknown pack: ${pack}` });
  }

  const key = generateLicenseKey(org);
  const siteUrl = process.env.SITE_URL || 'https://translategenie.github.io';
  const redirectUrl = `${siteUrl}/license?key=${encodeURIComponent(key)}`;

  try {
    const { json: licenses } = await loadLicenses();
    if (!Array.isArray(licenses)) {
      return respond(500, { ok: false, error: 'licenses.json must be an array' });
    }

    licenses.push({
      org,
      type: config.tier,
      requests: 0,
      limit: 0,
      characters: 0,
      charLimit: 0,
      key,
      valid: false,
    });
    await saveLicenses(licenses);

    const locationId = await getDefaultLocationId();

    const squareRes = await fetch(`${SQUARE_API}/online-checkout/payment-links`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify({
        idempotency_key: randomUUID(),
        quick_pay: {
          name: config.displayName,
          price_money: { amount: Math.round(config.amountCents * 1.05), currency: 'USD' },
          location_id: locationId,
        },
        checkout_options: {
          redirect_url: redirectUrl,
          merchant_support_email: 'support@translategenie.com',
        },
        payment_note: `org:${org}|pack:${pack}|key:${key}`,
      }),
    });

    const squareData = await squareRes.json();
    if (!squareRes.ok) {
      return respond(500, { ok: false, error: squareData?.errors?.[0]?.detail || 'Square API error' });
    }

    return respond(200, { ok: true, url: squareData.payment_link.url });
  } catch (err) {
    return respond(500, { ok: false, error: err.message || 'Failed to create checkout' });
  }
};
