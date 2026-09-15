import crypto from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyLengshanSignature } from '../src/lengshan-sales-auth.js';

const secret = 'test-lengshan-shared-secret';
const timestamp = '2026-09-15T08:00:00.000Z';
const rawBody = '{"eventId":"lengshan-event-0001"}';

function sign(body = rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
}

describe('Lengshan sales connector HMAC', () => {
  test('accepts a current signed payload and rejects a changed body', () => {
    expect(
      verifyLengshanSignature({
        timestamp,
        signature: `sha256=${sign()}`,
        rawBody,
        secret,
        now: new Date('2026-09-15T08:03:00.000Z'),
      }),
    ).toEqual({ ok: true });
    expect(
      verifyLengshanSignature({
        timestamp,
        signature: sign(),
        rawBody: `${rawBody} `,
        secret,
        now: new Date('2026-09-15T08:03:00.000Z'),
      }),
    ).toMatchObject({ ok: false, error: 'Invalid Lengshan signature' });
  });

  test('rejects expired signatures and an unconfigured connector', () => {
    expect(
      verifyLengshanSignature({
        timestamp,
        signature: sign(),
        rawBody,
        secret,
        now: new Date('2026-09-15T08:06:01.000Z'),
      }),
    ).toMatchObject({ ok: false, error: 'Expired Lengshan signature' });
    expect(
      verifyLengshanSignature({
        timestamp,
        signature: sign(),
        rawBody,
        secret: '',
      }),
    ).toMatchObject({ ok: false, status: 503 });
  });
});
