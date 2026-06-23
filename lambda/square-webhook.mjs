import { loadLicenses, saveLicenses } from './storage.mjs';

const PACK_INCREMENTS = {
  'one-wish': { requests: 10, characters: 200000, tier: 'T1' },
  starter:    { requests: 100, characters: 2000000, tier: 'T1' },
  small:      { requests: 500, characters: 10000000, tier: 'T1' },
  medium:     { requests: 2000, characters: 40000000, tier: 'T2' },
  enterprise: { requests: 10000, characters: 200000000, tier: 'T3' },
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { ok: false, error: 'Invalid JSON body' });
  }

  const eventType = payload?.type || '';

  try {
    // One-time payment via payment link
    if (eventType === 'payment.updated' || eventType === 'payment.completed') {
      const payment = payload?.data?.object?.payment;
      if (!payment || payment.status !== 'COMPLETED') {
        return respond(200, { ok: true, skipped: 'payment not completed' });
      }

      const note = payment.note || '';
      const keyMatch = note.match(/key:([A-Z0-9-]+)/);
      const packMatch = note.match(/pack:([a-z-]+)/);

      if (!keyMatch) {
        return respond(400, { ok: false, error: 'No license key in payment note' });
      }

      const licenseKey = keyMatch[1];
      const packKey = packMatch?.[1];
      const increment = packKey ? PACK_INCREMENTS[packKey] : null;

      if (!increment) {
        return respond(400, { ok: false, error: `Unknown pack: ${packKey}` });
      }

      const { json: licenses } = await loadLicenses();
      if (!Array.isArray(licenses)) {
        return respond(500, { ok: false, error: 'licenses.json must be an array' });
      }

      const index = licenses.findIndex((e) => e?.key === licenseKey);
      if (index === -1) {
        return respond(404, { ok: false, error: `License not found: ${licenseKey}` });
      }

      // Add credits on top of whatever the license already has. For a brand-new license the
      // pending record starts at 0, so 0 + pack == the pack amount; for a renewal the new
      // pack stacks onto the remaining balance. Used counters are left untouched.
      licenses[index].valid = true;
      licenses[index].limit = Number(licenses[index].limit || 0) + increment.requests;
      licenses[index].charLimit = Number(licenses[index].charLimit || 0) + increment.characters;
      licenses[index].type = increment.tier;

      await saveLicenses(licenses);
      return respond(200, { ok: true, key: licenseKey, eventType });
    }

    // Square sends test events — acknowledge silently
    return respond(200, { ok: true, skipped: `unhandled event: ${eventType}` });
  } catch (err) {
    return respond(500, { ok: false, error: err.message || 'Webhook processing failed' });
  }
};
