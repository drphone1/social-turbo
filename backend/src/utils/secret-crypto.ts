import crypto from 'crypto';

const SECRET_PREFIX = 'enc:v1';

function getEncryptionKey() {
  const seed = process.env.APP_ENCRYPTION_KEY
    || process.env.ENCRYPTION_KEY
    || process.env.GEMINI_API_KEY
    || process.env.OPENAI_API_KEY
    || process.cwd();

  return crypto.createHash('sha256').update(seed).digest();
}

export function isEncryptedSecret(value: string | null | undefined) {
  return typeof value === 'string' && value.startsWith(`${SECRET_PREFIX}:`);
}

export function encryptSecret(value: string | null | undefined) {
  if (!value) {
    return value || '';
  }

  if (isEncryptedSecret(value)) {
    return value;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    SECRET_PREFIX,
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptSecret(value: string | null | undefined) {
  if (!value) {
    return '';
  }

  if (!isEncryptedSecret(value)) {
    return value;
  }

  try {
    const [, ivBase64, authTagBase64, payloadBase64] = value.split(':');

    if (!ivBase64 || !authTagBase64 || !payloadBase64) {
      return value;
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getEncryptionKey(),
      Buffer.from(ivBase64, 'base64'),
    );

    decipher.setAuthTag(Buffer.from(authTagBase64, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payloadBase64, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch {
    return value;
  }
}

export function maskSecret(value: string | null | undefined) {
  const decrypted = decryptSecret(value);

  if (!decrypted) {
    return '****';
  }

  return `${decrypted.slice(0, 8)}****`;
}
