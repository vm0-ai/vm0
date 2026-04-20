/**
 * Email sender authentication via DMARC verification.
 *
 * Parses the Authentication-Results header (RFC 8601) from the upstream MTA
 * and enforces a DMARC-only policy: only dmarc=pass is accepted.
 *
 * Why DMARC-only:
 * - SPF validates envelope sender (MAIL FROM), not the From header.
 * - DKIM without DMARC doesn't enforce alignment with the From domain.
 * - DMARC is the only mechanism that guarantees From header alignment.
 */

// ============================================================================
// Types
// ============================================================================

type AuthResult =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "policy"
  | null;

interface AuthenticationResults {
  dmarc: AuthResult;
  dkim: AuthResult;
  spf: AuthResult;
}

interface SenderVerification {
  verified: boolean;
  reason: string;
  details: AuthenticationResults;
}

// ============================================================================
// Parser
// ============================================================================

const AUTH_RESULT_VALUES = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
] as const;

type AuthResultValue = (typeof AUTH_RESULT_VALUES)[number];

function isAuthResultValue(value: string): value is AuthResultValue {
  return (AUTH_RESULT_VALUES as readonly string[]).includes(value);
}

/**
 * Parse an Authentication-Results header value into structured results.
 *
 * Extracts dmarc=, dkim=, spf= results from the header string.
 * Case-insensitive matching per RFC 8601.
 */
function parseAuthenticationResults(
  headerValue: string,
): AuthenticationResults {
  const lower = headerValue.toLowerCase();

  function extractResult(method: RegExp): AuthResult {
    const match = lower.match(method);
    if (!match?.[1]) return null;
    return isAuthResultValue(match[1]) ? match[1] : null;
  }

  return {
    dmarc: extractResult(/dmarc\s*=\s*(\w+)/),
    dkim: extractResult(/dkim\s*=\s*(\w+)/),
    spf: extractResult(/spf\s*=\s*(\w+)/),
  };
}

// ============================================================================
// Decision Function
// ============================================================================

/**
 * Verify sender authenticity based on Authentication-Results header.
 *
 * DMARC-only policy: only dmarc=pass is accepted, everything else is rejected.
 */
export function verifySenderAuthenticity(
  headers: Record<string, string>,
): SenderVerification {
  // Case-insensitive header lookup
  const headerKey = Object.keys(headers).find((k) => {
    return k.toLowerCase() === "authentication-results";
  });

  if (!headerKey) {
    return {
      verified: false,
      reason: "no authentication-results header found",
      details: { dmarc: null, dkim: null, spf: null },
    };
  }

  const details = parseAuthenticationResults(headers[headerKey]!);

  // Only DMARC pass is accepted
  if (details.dmarc === "pass") {
    return { verified: true, reason: "dmarc=pass", details };
  }

  // Everything else is rejected
  return {
    verified: false,
    reason: `dmarc=${details.dmarc ?? "missing"}`,
    details,
  };
}
