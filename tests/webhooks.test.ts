import { describe, expect, it } from 'vitest';

import {
  createWebhookSecret,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  signWebhook,
  verifyWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookVerificationError,
  type WebhookSignedHeaders,
  type WebhookVerificationErrorCode,
} from '../src/index';

const PRIMARY_SECRET = 'whsec_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';
const SECONDARY_SECRET = 'whsec_ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0A=';
const WEBHOOK_ID = 'msg_test_123';
const WEBHOOK_TIMESTAMP = 1_674_087_231;
const RAW_BODY = '{"type":"example.event","data":{"id":42}}';
const PRIMARY_SIGNATURE = 'v1,WS15G0YcJzoLryU63PRddNzUxB83Kxm2iKZpq99tjSM=';
const SECONDARY_SIGNATURE = 'v1,CAgxGN03p5Eh1PZurGdMfyg/jTOrT9d9p6RXrPJtIgQ=';

const BASE_VERIFY_OPTIONS = {
  nowSeconds: WEBHOOK_TIMESTAMP + 60,
};

describe('Standard Webhooks utilities', () => {
  it('creates whsec_ secrets that can sign and verify webhooks', () => {
    const secret = createWebhookSecret();
    const headers = signWebhook(secret, RAW_BODY, {
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });

    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/);
    expect(verifyWebhook(secret, headers, RAW_BODY, BASE_VERIFY_OPTIONS)).toEqual({
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });
  });

  it.each([23, 65, 1.5])('rejects invalid generated secret byte lengths: %s', (byteLength) => {
    expect(() => createWebhookSecret(byteLength)).toThrow(RangeError);
  });

  it('signs deterministic Standard Webhooks headers with whsec_ secrets', () => {
    expect(
      signWebhook(PRIMARY_SECRET, RAW_BODY, {
        id: WEBHOOK_ID,
        timestampSeconds: WEBHOOK_TIMESTAMP,
      }),
    ).toEqual({
      [WEBHOOK_ID_HEADER]: WEBHOOK_ID,
      [WEBHOOK_TIMESTAMP_HEADER]: String(WEBHOOK_TIMESTAMP),
      [WEBHOOK_SIGNATURE_HEADER]: PRIMARY_SIGNATURE,
    });
  });

  it('verifies deterministic raw-body signatures', () => {
    const headers = signedHeaders();

    expect(verifyWebhook(PRIMARY_SECRET, headers, RAW_BODY, BASE_VERIFY_OPTIONS)).toEqual({
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });
  });

  it('accepts case-insensitive WHATWG Headers input', () => {
    const headers = new Headers();
    headers.set('Webhook-Id', WEBHOOK_ID);
    headers.set('Webhook-Timestamp', String(WEBHOOK_TIMESTAMP));
    headers.set('Webhook-Signature', PRIMARY_SIGNATURE);

    expect(verifyWebhook(PRIMARY_SECRET, headers, RAW_BODY, BASE_VERIFY_OPTIONS)).toEqual({
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });
  });

  it('fails if the raw body bytes are changed', () => {
    const headers = signedHeaders();

    expectVerificationError(
      () => verifyWebhook(PRIMARY_SECRET, headers, '{"data":{"id":42},"type":"example.event"}', BASE_VERIFY_OPTIONS),
      'signature_mismatch',
    );
  });

  it('preserves byte-level body sensitivity for Buffer and Uint8Array inputs', () => {
    const body = Buffer.from([0, 1, 2, 255, 65]);
    const headers = signWebhook(PRIMARY_SECRET, body, {
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });

    expect(verifyWebhook(PRIMARY_SECRET, headers, new Uint8Array(body), BASE_VERIFY_OPTIONS)).toEqual({
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });

    const tampered = Buffer.from(body);
    tampered[1] = 9;
    expectVerificationError(
      () => verifyWebhook(PRIMARY_SECRET, headers, tampered, BASE_VERIFY_OPTIONS),
      'signature_mismatch',
    );
  });

  it('emits and verifies space-delimited multi-signature rotation headers', () => {
    const headers = signWebhook([PRIMARY_SECRET, SECONDARY_SECRET], RAW_BODY, {
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });

    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(`${PRIMARY_SIGNATURE} ${SECONDARY_SIGNATURE}`);
    expect(verifyWebhook(SECONDARY_SECRET, headers, RAW_BODY, BASE_VERIFY_OPTIONS)).toEqual({
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });
  });

  it('ignores unsupported signature versions when a valid v1 signature is present', () => {
    const headers = {
      ...signedHeaders(),
      [WEBHOOK_SIGNATURE_HEADER]: `v1a,${Buffer.alloc(64, 9).toString('base64')} ${PRIMARY_SIGNATURE}`,
    };

    expect(verifyWebhook(PRIMARY_SECRET, headers, RAW_BODY, BASE_VERIFY_OPTIONS)).toEqual({
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });
  });

  it.each([
    WEBHOOK_ID_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    WEBHOOK_SIGNATURE_HEADER,
  ])('rejects missing required header: %s', (headerName) => {
    const headers: Record<string, string> = {
      [WEBHOOK_ID_HEADER]: WEBHOOK_ID,
      [WEBHOOK_TIMESTAMP_HEADER]: String(WEBHOOK_TIMESTAMP),
      [WEBHOOK_SIGNATURE_HEADER]: PRIMARY_SIGNATURE,
    };
    delete headers[headerName];

    expectVerificationError(
      () => verifyWebhook(PRIMARY_SECRET, headers, RAW_BODY, BASE_VERIFY_OPTIONS),
      'missing_header',
    );
  });

  it.each([
    ['malformed timestamp', { [WEBHOOK_TIMESTAMP_HEADER]: 'not-a-number' }, 'invalid_timestamp'],
    ['stale timestamp', {}, 'timestamp_outside_tolerance'],
    ['future timestamp', {}, 'timestamp_outside_tolerance'],
    [
      'bad signature',
      { [WEBHOOK_SIGNATURE_HEADER]: `v1,${Buffer.alloc(32, 1).toString('base64')}` },
      'signature_mismatch',
    ],
    ['malformed signature header', { [WEBHOOK_SIGNATURE_HEADER]: 'v1' }, 'invalid_header'],
  ] as const)('rejects %s', (_caseName, headerOverrides, expectedCode) => {
    const options =
      _caseName === 'stale timestamp'
        ? { nowSeconds: WEBHOOK_TIMESTAMP + DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1 }
        : _caseName === 'future timestamp'
          ? { nowSeconds: WEBHOOK_TIMESTAMP - DEFAULT_WEBHOOK_TOLERANCE_SECONDS - 1 }
          : BASE_VERIFY_OPTIONS;

    expectVerificationError(
      () =>
        verifyWebhook(
          PRIMARY_SECRET,
          {
            ...signedHeaders(),
            ...headerOverrides,
          },
          RAW_BODY,
          options,
        ),
      expectedCode,
    );
  });

  it('rejects malformed whsec_ secrets during verification', () => {
    expectVerificationError(
      () => verifyWebhook('whsec_not-base64', signedHeaders(), RAW_BODY, BASE_VERIFY_OPTIONS),
      'invalid_secret',
    );
  });

  it('uses a safe default replay window and allows an explicit tolerance', () => {
    const headers = signedHeaders();

    expect(
      verifyWebhook(PRIMARY_SECRET, headers, RAW_BODY, {
        nowSeconds: WEBHOOK_TIMESTAMP + DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
      }),
    ).toEqual({
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });

    expectVerificationError(
      () =>
        verifyWebhook(PRIMARY_SECRET, headers, RAW_BODY, {
          nowSeconds: WEBHOOK_TIMESTAMP + DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1,
        }),
      'timestamp_outside_tolerance',
    );

    expect(
      verifyWebhook(PRIMARY_SECRET, headers, RAW_BODY, {
        nowSeconds: WEBHOOK_TIMESTAMP + 600,
        toleranceSeconds: 600,
      }),
    ).toEqual({
      id: WEBHOOK_ID,
      timestampSeconds: WEBHOOK_TIMESTAMP,
    });
  });
});

function signedHeaders(): WebhookSignedHeaders {
  return {
    [WEBHOOK_ID_HEADER]: WEBHOOK_ID,
    [WEBHOOK_TIMESTAMP_HEADER]: String(WEBHOOK_TIMESTAMP),
    [WEBHOOK_SIGNATURE_HEADER]: PRIMARY_SIGNATURE,
  };
}

function expectVerificationError(action: () => unknown, code: WebhookVerificationErrorCode): void {
  try {
    action();
    throw new Error('Expected verifyWebhook to throw.');
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect((error as WebhookVerificationError).code).toBe(code);
  }
}
