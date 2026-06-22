import { loadLicenses, saveLicenses } from '../lib/storage.js';

const PACK_INCREMENTS = {
  'one-wish': { requests: 10, characters: 200000 },
  starter: { requests: 100, characters: 2000000 },
  small: { requests: 500, characters: 10000000 },
  medium: { requests: 2000, characters: 40000000 },
  enterprise: { requests: 10000, characters: 200000000 },
  t1: { requests: 500, characters: 10000000 },
  t2: { requests: 2000, characters: 40000000 },
  t3: { requests: 10000, characters: 200000000 },
};

function getPurchasedPack(reqBody) {
  const candidate = String(
    reqBody?.data?.tier
      || reqBody?.data?.pack
      || reqBody?.data?.plan
      || reqBody?.data?.object?.subscription?.plan_id
      || ''
  ).toLowerCase();

  if (!candidate) return null;
  if (candidate.includes('starter') || candidate.includes('100')) return 'starter';
  if (candidate.includes('small') || candidate.includes('t1') || candidate.includes('500')) return 'small';
  if (candidate.includes('medium') || candidate.includes('t2') || candidate.includes('2000')) return 'medium';
  if (candidate.includes('enterprise') || candidate.includes('t3') || candidate.includes('10000')) return 'enterprise';
  return null;
}

export async function squareWebhookHandler(req, res) {
  const eventType = req.body?.type || '';

  try {
    // One-time payment via payment link (created by /api/create-checkout)
    if (eventType === 'payment.updated' || eventType === 'payment.completed') {
      const payment = req.body?.data?.object?.payment;
      if (!payment || payment.status !== 'COMPLETED') {
        return res.status(200).json({ ok: true, skipped: 'payment not completed' });
      }

      const note = payment.note || '';
      const keyMatch = note.match(/key:([A-Z0-9-]+)/);
      const packMatch = note.match(/pack:([a-z-]+)/);

      if (!keyMatch) {
        return res.status(400).json({ ok: false, error: 'No license key in payment note' });
      }

      const licenseKey = keyMatch[1];
      const packKey = packMatch?.[1];
      const increment = packKey ? PACK_INCREMENTS[packKey] : null;

      if (!increment) {
        return res.status(400).json({ ok: false, error: `Unknown pack in payment note: ${packKey}` });
      }

      const { json: licenses, etag } = await loadLicenses();
      if (!Array.isArray(licenses)) {
        return res.status(500).json({ ok: false, error: 'licenses.json must be an array' });
      }

      const index = licenses.findIndex((entry) => entry?.key === licenseKey);
      if (index === -1) {
        return res.status(404).json({ ok: false, error: `License not found: ${licenseKey}` });
      }

      licenses[index].valid = true;
      licenses[index].limit = increment.requests;
      licenses[index].charLimit = increment.characters;

      await saveLicenses(licenses, etag, `payment completed for key ${licenseKey}`);
      return res.status(200).json({ ok: true, key: licenseKey, eventType });
    }

    // Subscription / invoice events (legacy — match by org name)
    const org = req.body?.data?.org;
    const purchasedPack = getPurchasedPack(req.body);

    if (!org) {
      return res.status(400).json({ ok: false, error: 'data.org is required for subscription events' });
    }

    const { json: licenses, etag } = await loadLicenses();
    if (!Array.isArray(licenses)) {
      return res.status(500).json({ ok: false, error: 'licenses.json must be an array' });
    }

    const index = licenses.findIndex((entry) => entry?.org === org);
    if (index === -1) {
      return res.status(404).json({ ok: false, error: 'organization not found' });
    }

    if (eventType === 'subscription.canceled' || eventType === 'invoice.payment_failed') {
      licenses[index].valid = false;
    }

    if (eventType === 'subscription.renewed' || eventType === 'invoice.payment_made') {
      const increment = purchasedPack ? PACK_INCREMENTS[purchasedPack] : null;
      if (!increment) {
        return res.status(400).json({ ok: false, error: 'Unable to determine purchased tier/pack from webhook payload' });
      }

      licenses[index].valid = true;
      licenses[index].limit = Number(licenses[index].limit || 0) + increment.requests;
      licenses[index].charLimit = Number(licenses[index].charLimit || 0) + increment.characters;
    }

    await saveLicenses(licenses, etag, `square webhook ${eventType} for ${org}`);
    return res.status(200).json({ ok: true, org, eventType });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to process square webhook' });
  }
}
