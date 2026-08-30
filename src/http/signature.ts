import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifying the platform's `X-Hub-Signature-256` header (REQ-002).
 *
 * The webhook route cannot sit behind authentication — it is public by nature,
 * and a hard rule of the KEEL forbids putting any auth layer in front of it,
 * because that makes deliveries fail silently and can unsubscribe the app. The
 * signature is therefore the ONLY thing separating a real platform event from
 * anyone who found the URL.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 * - the digest is computed over the RAW body, byte for byte. Parsing to JSON
 *   and re-serialising changes whitespace and key order, and the digest stops
 *   matching for reasons that look like a platform bug;
 * - the comparison is constant-time. A plain `===` leaks, through timing, how
 *   many leading bytes were right, which is enough to forge a signature one
 *   byte at a time.
 */

const PREFIX = "sha256=";

export type SignatureVerdict =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: "missing" | "malformed" | "mismatch";
    };

/**
 * @param rawBody the exact bytes received, never a re-serialised object
 * @param header  value of `X-Hub-Signature-256`, or undefined if absent
 * @param secret  the app secret
 */
export function verifySignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
): SignatureVerdict {
  if (header === undefined || header === "") {
    return { valid: false, reason: "missing" };
  }

  if (!header.startsWith(PREFIX)) {
    return { valid: false, reason: "malformed" };
  }

  const received = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(received)) {
    return { valid: false, reason: "malformed" };
  }

  const expected = createHmac("sha256", secret)
    .update(
      typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody,
    )
    .digest("hex");

  // Both are 64 hex chars by construction here, so the lengths always match
  // and timingSafeEqual cannot throw.
  const matches = timingSafeEqual(
    Buffer.from(received.toLowerCase(), "utf8"),
    Buffer.from(expected, "utf8"),
  );

  return matches ? { valid: true } : { valid: false, reason: "mismatch" };
}
