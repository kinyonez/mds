import { describe, expect, it } from 'vitest';
import { decryptToken, decryptWithKey, encryptToken } from '../src/lib/platform/crypto';

describe('トークン暗号化', () => {
  it('暗号化して復号できる。パスフレーズ違いは失敗', async () => {
    const { enc, key } = await encryptToken('github_pat_xxx', 'correct horse');
    expect(key.extractable).toBe(false);
    expect((await decryptToken(enc, 'correct horse')).token).toBe('github_pat_xxx');
    expect(await decryptWithKey(enc, key)).toBe('github_pat_xxx');
    await expect(decryptToken(enc, 'wrong')).rejects.toThrow('パスフレーズが違います');
  }, 20_000);
});
