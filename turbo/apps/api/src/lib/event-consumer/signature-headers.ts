import { logger } from "../log";

const L = logger("api:legacy-signature-header");

/** Header names a caller should send. */
const SIGNATURE_HEADER = "X-Okou-Signature";
const TIMESTAMP_HEADER = "X-Okou-Timestamp";

/** Pre-rename header names, still emitted by every sender in this release. */
const LEGACY_SIGNATURE_HEADER = "X-VM0-Signature";
const LEGACY_TIMESTAMP_HEADER = "X-VM0-Timestamp";

/** Verification site that accepted a request, recorded on the legacy signal. */
type SignatureHeaderSurface = "callback-route" | "workflow-webhook";

interface SignatureHeaders {
  readonly signature: string | null;
  readonly timestamp: string | null;
  /** True when a value was taken from a legacy header name. */
  readonly legacy: boolean;
}

type ReadHeader = (name: string) => string | null | undefined;

/**
 * Read the HMAC signature headers, preferring `X-Okou-*` and falling back per
 * header to the legacy `X-VM0-*` name.
 *
 * Fallback surface: an API instance draining across a deploy window still
 * signs the legacy names, and the published curl snippets still document them.
 * Gate for removal: every sender emits `X-Okou-*` (#33497) in production and
 * {@link reportLegacySignatureHeaderUse} has gone silent over an observation
 * window. Removed together with that signal by #33498.
 *
 * `readHeader` is case-insensitive at both call sites — Hono's `req.header`
 * and `Headers.get`.
 */
export function readSignatureHeaders(readHeader: ReadHeader): SignatureHeaders {
  const signature = readHeader(SIGNATURE_HEADER) ?? null;
  const timestamp = readHeader(TIMESTAMP_HEADER) ?? null;
  const legacySignature =
    signature === null ? (readHeader(LEGACY_SIGNATURE_HEADER) ?? null) : null;
  const legacyTimestamp =
    timestamp === null ? (readHeader(LEGACY_TIMESTAMP_HEADER) ?? null) : null;
  return {
    signature: signature ?? legacySignature,
    timestamp: timestamp ?? legacyTimestamp,
    legacy: legacySignature !== null || legacyTimestamp !== null,
  };
}

/**
 * Record that a request whose signature verified arrived under a legacy header
 * name, so #33498 can gate the removal of the fallback above on observed
 * silence instead of elapsed time.
 *
 * Emitted at warn under a fixed logger context, so the gate is a single
 * queryable filter: the Axiom transport drops debug records, and a caller that
 * still signs the legacy name is the actionable finding release 3 acts on.
 * Every sender emits the legacy name until #33497 ships, so this is expected
 * to be loud for releases 1 and 2 and silent afterwards.
 *
 * Restricting it to requests that verified keeps an unauthenticated caller
 * from driving log volume through the public webhook endpoint, and keeps the
 * signal to callers holding a valid secret — the ones release 3 would reject.
 */
export function reportLegacySignatureHeaderUse(
  surface: SignatureHeaderSurface,
): void {
  L.warn("Verified a request signed with a legacy signature header name", {
    type: "legacy_signature_header_use",
    surface,
  });
}
