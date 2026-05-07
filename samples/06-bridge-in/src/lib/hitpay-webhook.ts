// HitPay webhook signature verification.
//
// HitPay signs every webhook payload with HMAC-SHA256 of the raw JSON body
// using the dashboard "salt" as the secret key. The signature is hex-encoded
// and delivered in the `Hitpay-Signature` header.
//
// See: docs.hitpayapp.com → Webhooks → Signature verification.

import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyHitpaySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  salt: string,
): boolean {
  if (!signatureHeader) return false
  // Strip a `sha256=` prefix if HitPay ever sends one (defensive).
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader
  const expected = createHmac('sha256', salt).update(rawBody).digest('hex')
  if (provided.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}
