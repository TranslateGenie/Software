import { Client, Environment } from 'square';
import { randomUUID } from 'node:crypto';
import { loadLicenses, saveLicenses } from './storage.mjs';

const PACK_CONFIG = {
  'one-wish':   { amountCents: 1000n,   requests: 10,    characters: 200000,    displayName: 'One Wish',        tier: 'T1' },
  'starter':    { amountCents: 9900n,   requests: 100,   characters: 2000000,   displayName: 'Two Wishes',      tier: 'T1' },
  'small':      { amountCents: 35000n,  requests: 500,   characters: 10000000,  displayName: 'Three Wishes',    tier: 'T1' },
  'medium':     { amountCents: 125000n, requests: 2000,  characters: 40000000,  displayName: 'Genie Sidekick',  tier: 'T2' },
  'enterprise': { amountCents: 500000n, requests: 10000, characters: 200000000, displayName: 'Genie Companion', tier: 'T3' },
};

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://translategenie.github.io';

function generateLicenseKey(org) {
  const root = (org || 'TGEN').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4) || 'TGEN';
  const rand = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${root}-${rand()}-${rand()}-${rand()}`;
}

let squareClient = null;
let cachedLocationId = null;

function getSquareClient() {
  if (!squareClient) {
    squareClient = new Client({
      accessToken: process.env.SQUARE_ACCESS_TOKEN,
      environment: process.env.SQUARE_ENVIRONMENT === 'sandbox'
        ? Environment.Sandbox
        : Environment.Production,
    });
  }
  return squareClient;
}

async function getDefaultLocationId() {
  if (cachedLocationId) return cachedLocationId;
  const { result } = await getSquareClient().locationsApi.listLocations();
  const active = (result.locations || []).filter(l => l.status === 'ACTIVE');
  if (!active.length) throw new Error('No active Square locations found');
  cachedLocationId = active[0].id;
  return cachedLocationId;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS' || event.httpMethod === 'OPTIONS') {
    return respond(204, {});
  }

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
    const { result } = await getSquareClient().checkoutApi.createPaymentLink({
      idempotencyKey: randomUUID(),
      quickPay: {
        name: config.displayName,
        priceMoney: { amount: config.amountCents, currency: 'USD' },
        locationId,
      },
      checkoutOptions: {
        redirectUrl,
        merchantSupportEmail: 'support@translategenie.com',
      },
      paymentNote: `org:${org}|pack:${pack}|key:${key}`,
    });

    return respond(200, { ok: true, url: result.paymentLink.url });
  } catch (err) {
    return respond(500, { ok: false, error: err.message || 'Failed to create checkout' });
  }
};
