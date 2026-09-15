import crypto from 'node:crypto';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type LengshanSignatureVerification =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

function parseTimestamp(value: string): number | null {
  if (/^\d{10,13}$/u.test(value)) {
    const numeric = Number(value);
    const millis = value.length === 10 ? numeric * 1000 : numeric;
    return Number.isFinite(millis) ? millis : null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Lengshan signs UTF-8 request bytes using:
 * HMAC_SHA256(`${X-Lengshan-Timestamp}.${rawBody}`, sharedSecret)
 *
 * The secret is intentionally server-only. A missing secret leaves the
 * connector disabled instead of silently accepting unauthenticated traffic.
 */
export function verifyLengshanSignature(input: {
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  now?: Date;
  secret?: string;
}): LengshanSignatureVerification {
  const secret = input.secret ?? process.env.LENGSHAN_SALES_WEBHOOK_SECRET;
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: 'Lengshan connector is not configured',
    };
  }
  if (!input.timestamp || !input.signature) {
    return { ok: false, status: 401, error: 'Missing Lengshan signature' };
  }
  const timestampMs = parseTimestamp(input.timestamp);
  if (
    timestampMs === null ||
    Math.abs((input.now || new Date()).getTime() - timestampMs) >
      MAX_CLOCK_SKEW_MS
  ) {
    return { ok: false, status: 401, error: 'Expired Lengshan signature' };
  }
  const supplied = input.signature.replace(/^sha256=/iu, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(supplied)) {
    return { ok: false, status: 401, error: 'Malformed Lengshan signature' };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${input.timestamp}.${input.rawBody}`, 'utf8')
    .digest('hex');
  const valid = crypto.timingSafeEqual(
    Buffer.from(supplied, 'hex'),
    Buffer.from(expected, 'hex'),
  );
  return valid
    ? { ok: true }
    : { ok: false, status: 401, error: 'Invalid Lengshan signature' };
}
