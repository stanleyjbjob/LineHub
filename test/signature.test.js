import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSignature, verifySignature } from '../src/line/signature.js';

test('驗證 LINE 簽章', () => {
  const body = Buffer.from('{"events":[]}');
  const sig = computeSignature('secret', body);
  assert.equal(verifySignature('secret', body, sig), true);
  assert.equal(verifySignature('other', body, sig), false);
  assert.equal(verifySignature('secret', body, undefined), false);
  assert.equal(verifySignature('secret', body, 'short'), false);
});
