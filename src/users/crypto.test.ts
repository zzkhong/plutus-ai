import test from 'node:test';
import assert from 'node:assert/strict';

test('encrypt then decrypt returns the original plaintext', async () => {
  const { encrypt, decrypt } = await import('./crypto');
  const plaintext = 'AIzaSyFakeGeminiKeyForTesting1234567890';

  const ciphertext = encrypt(plaintext);
  assert.notEqual(ciphertext, plaintext);

  const decrypted = decrypt(ciphertext);
  assert.equal(decrypted, plaintext);
});

test('encrypt produces a different ciphertext each time for the same plaintext', async () => {
  const { encrypt } = await import('./crypto');
  const a = encrypt('same-plaintext');
  const b = encrypt('same-plaintext');
  assert.notEqual(a, b);
});

test('decrypt throws on a malformed ciphertext', async () => {
  const { decrypt } = await import('./crypto');
  assert.throws(() => decrypt('not-a-real-ciphertext'));
});

test('decrypt throws when the ciphertext has been tampered with', async () => {
  const { encrypt, decrypt } = await import('./crypto');
  const ciphertext = encrypt('some-api-key');
  const [iv, authTag, data] = ciphertext.split(':');
  const tampered = `${iv}:${authTag}:${data.slice(0, -2)}ff`;
  assert.throws(() => decrypt(tampered));
});
