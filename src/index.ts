/**
 * Posthorn — open-core, Standard Webhooks-compliant reliable webhook delivery.
 *
 * Public entrypoint. As the delivery core, persistence, and HTTP API land
 * (see docs/PROJECT.md), their stable surfaces are re-exported here.
 */
export {
  sign,
  verify,
  generateSecret,
  WebhookVerificationError,
  HEADERS,
  type SignInput,
  type VerifyHeaders,
  type VerifyOptions,
} from "./signing/webhook-signature.js";
