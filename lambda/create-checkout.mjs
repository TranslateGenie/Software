import { randomUUID } from 'node:crypto';
import { loadLicenses, saveLicenses } from './storage.mjs';
import { generateUniqueLicenseKey } from './license-key.mjs';

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';

const PACK_CONFIG = {
  'one-wish':   { amountCents: 1000,   requests: 10,    characters: 200000,    displayName: 'One Wish',        tier: 'T1' },
  'starter':    { amountCents: 9900,   requests: 100,   characters: 2000000,   displayName: 'Two Wishes',      tier: 'T1' },
  'small':      { amountCents: 35000,  requests: 500,   characters: 10000000,  displayName: 'Three Wishes',    tier: 'T1' },
  'medium':     { amountCents: 125000, requests: 2000,  characters: 40000000,  displayName: 'Genie Sidekick',  tier: 'T2' },
  'enterprise': { amountCents: 500000, requests: 10000, characters: 200000000, displayName: 'Genie Companion', tier: 'T3' },
};

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
  let org, pack, renewKey;
  try {
    const body = JSON.parse(event.body || '{}');
    org = body.org;
    pack = body.pack;
    renewKey = (body.key || '').trim();
  } catch {
    return respond(400, { ok: false, error: 'Invalid JSON body' });
  }

  // org is only required for a brand-new purchase; a renewal reuses the existing record's org.
  if (!pack || (!org && !renewKey)) {
    return respond(400, { ok: false, error: 'pack and org are required' });
  }

  const config = PACK_CONFIG[pack];
  if (!config) {
    return respond(400, { ok: false, error: `Unknown pack: ${pack}` });
  }

  try {
    const { json: licenses } = await loadLicenses();
    if (!Array.isArray(licenses)) {
      return respond(500, { ok: false, error: 'licenses.json must be an array' });
    }

    // Renewal if a known key was supplied; otherwise a brand-new purchase.
    const existingRecord = renewKey ? licenses.find((l) => l?.key === renewKey) : null;

    let key;
    if (existingRecord) {
      // Renewal: reuse the key as-is. The webhook will add credits on payment, so we don't
      // touch licenses.json here (no new record, no save).
      key = existingRecord.key;
    } else {
      // New purchase: mint a unique key and write a pending record the webhook will activate.
      const existingKeys = new Set(licenses.map((l) => l?.key).filter(Boolean));
      key = generateUniqueLicenseKey(existingKeys);
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
    }

    const siteUrl = process.env.SITE_URL || 'https://translategenie.github.io';
    const redirectUrl = `${siteUrl}/license?key=${encodeURIComponent(key)}`;
    const noteOrg = org || existingRecord?.org || '';

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
        payment_note: `org:${noteOrg}|pack:${pack}|key:${key}`,
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
