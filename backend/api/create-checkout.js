import { Client, Environment } from 'square';
import { randomUUID } from 'node:crypto';
import { loadLicenses, saveLicenses } from '../lib/storage.js';

const PACK_CONFIG = {
  'one-wish':   { amountCents: 1000n,   requests: 10,    characters: 200000,    displayName: 'One Wish',        tier: 'T1' },
  'starter':    { amountCents: 9900n,   requests: 100,   characters: 2000000,   displayName: 'Two Wishes',      tier: 'T1' },
  'small':      { amountCents: 35000n,  requests: 500,   characters: 10000000,  displayName: 'Three Wishes',    tier: 'T1' },
  'medium':     { amountCents: 125000n, requests: 2000,  characters: 40000000,  displayName: 'Genie Sidekick',  tier: 'T2' },
  'enterprise': { amountCents: 500000n, requests: 10000, characters: 200000000, displayName: 'Genie Companion', tier: 'T3' },
};

function generateLicenseKey(org) {
  const root = (org || 'TGEN').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4) || 'TGEN';
  const rand = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${root}-${rand()}-${rand()}-${rand()}`;
}

let squareClient = null;
let cachedLocationId = null;

function getSquareClient() {
  if (!squareClient) {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) throw new Error('SQUARE_ACCESS_TOKEN is not configured');
    squareClient = new Client({
      accessToken: token,
      environment: process.env.SQUARE_ENVIRONMENT === 'sandbox'
        ? Environment.Sandbox
        : Environment.Production,
    });
  }
  return squareClient;
}

async function getDefaultLocationId() {
  if (cachedLocationId) return cachedLocationId;
  const client = getSquareClient();
  const { result } = await client.locationsApi.listLocations();
  const active = (result.locations || []).filter(l => l.status === 'ACTIVE');
  if (!active.length) throw new Error('No active Square locations found');
  cachedLocationId = active[0].id;
  return cachedLocationId;
}

export async function createCheckoutHandler(req, res) {
  const { org, pack } = req.body || {};

  if (!org || !pack) {
    return res.status(400).json({ ok: false, error: 'org and pack are required' });
  }

  const config = PACK_CONFIG[pack];
  if (!config) {
    return res.status(400).json({ ok: false, error: `Unknown pack: ${pack}` });
  }

  const key = generateLicenseKey(org);
  const port = process.env.LOCAL_HELPER_PORT || 8787;
  const siteUrl = process.env.SITE_URL || `http://127.0.0.1:${port}`;
  const redirectUrl = `${siteUrl}/license?key=${encodeURIComponent(key)}`;

  try {
    // Write pending license — limits are zeroed until webhook activates it on payment
    const { json: licenses, etag } = await loadLicenses();
    if (!Array.isArray(licenses)) {
      return res.status(500).json({ ok: false, error: 'licenses.json must be an array' });
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
    await saveLicenses(licenses, etag, `pending purchase ${key}`);

    // Create Square payment link
    const locationId = await getDefaultLocationId();
    const client = getSquareClient();

    const { result } = await client.checkoutApi.createPaymentLink({
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

    return res.json({ ok: true, url: result.paymentLink.url });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to create checkout' });
  }
}
