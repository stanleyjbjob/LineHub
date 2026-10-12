import crypto from 'node:crypto';

// LINE 會以 Channel secret 對「原始 request body」做 HMAC-SHA256，並 base64 後放在 x-line-signature
export function computeSignature(channelSecret, rawBody) {
  return crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
}

export function verifySignature(channelSecret, rawBody, signature) {
  if (!channelSecret || !signature) return false;
  const expected = Buffer.from(computeSignature(channelSecret, rawBody));
  const actual = Buffer.from(String(signature));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
