/**
 * トークンの暗号化。パスフレーズから PBKDF2（SHA-256、600,000 回）で鍵を導出し、AES-GCM で暗号化する。
 * 「このデバイスで記憶する」では導出済みの鍵を extractable: false の CryptoKey のまま保存する。
 */

export const PBKDF2_ITERATIONS = 600_000;

export interface EncryptedToken {
  ct: ArrayBuffer;
  iv: Uint8Array;
  salt: Uint8Array;
  iterations: number;
}

export async function deriveKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptToken(token: string, passphrase: string): Promise<{ enc: EncryptedToken; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(token));
  return { enc: { ct, iv, salt, iterations: PBKDF2_ITERATIONS }, key };
}

export async function decryptWithKey(enc: EncryptedToken, key: CryptoKey): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: enc.iv as BufferSource }, key, enc.ct);
  return new TextDecoder().decode(pt);
}

/** パスフレーズが違えば例外 */
export async function decryptToken(enc: EncryptedToken, passphrase: string): Promise<{ token: string; key: CryptoKey }> {
  const key = await deriveKey(passphrase, enc.salt, enc.iterations);
  try {
    return { token: await decryptWithKey(enc, key), key };
  } catch {
    throw new Error('パスフレーズが違います');
  }
}
