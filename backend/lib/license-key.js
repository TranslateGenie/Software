import { randomInt } from 'node:crypto';

const PREFIX = 'TGEN';
// Uppercase letters + digits, excluding look-alikes 0/O and 1/I/L for easy reading.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomGroup() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

// existing: a Set or array of keys already in the DB (valid or not). Regenerates on collision.
export function generateUniqueLicenseKey(existing) {
  const taken = existing instanceof Set ? existing : new Set(existing);
  let key;
  do {
    key = `${PREFIX}-${randomGroup()}-${randomGroup()}-${randomGroup()}`;
  } while (taken.has(key));
  return key;
}
