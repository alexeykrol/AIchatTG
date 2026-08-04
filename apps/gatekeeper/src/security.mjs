import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createStartToken(invitationId, version, secret) {
  const compactId = String(invitationId).replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(compactId)) throw new Error('invitation id must be a UUID');
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('token version must be a positive integer');
  const unsigned = `g1_${compactId.toLowerCase()}_${version.toString(36)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url').slice(0, 16);
  return `${unsigned}_${signature}`;
}

export function createSiteOnboardingToken(siteCaseId, version, secret) {
  const compactId = String(siteCaseId).replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(compactId)) throw new Error('site case id must be a UUID');
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('token version must be a positive integer');
  const unsigned = `w1_${compactId.toLowerCase()}_${version.toString(36)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url').slice(0, 20);
  return `${unsigned}_${signature}`;
}

function updateEncryptionKey(secret) {
  return createHash('sha256').update(`telegram-gatekeeper-update:${secret}`).digest();
}

function privateValueEncryptionKey(secret) {
  return createHash('sha256').update(`telegram-gatekeeper-private-value:${secret}`).digest();
}

function privateValueFingerprintKey(secret) {
  return createHash('sha256').update(`telegram-gatekeeper-private-fingerprint:${secret}`).digest();
}

export function encryptUpdateBody(rawBody, secret, iv = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm', updateEncryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(rawBody, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptUpdateBody({ ciphertext, iv, tag }, secret) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    updateEncryptionKey(secret),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptPrivateValue(value, secret, iv = randomBytes(12)) {
  const cipher = createCipheriv('aes-256-gcm', privateValueEncryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptPrivateValue({ ciphertext, iv, tag }, secret) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    privateValueEncryptionKey(secret),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function privateValueFingerprint(value, secret) {
  return createHmac('sha256', privateValueFingerprintKey(secret)).update(value).digest('hex');
}
