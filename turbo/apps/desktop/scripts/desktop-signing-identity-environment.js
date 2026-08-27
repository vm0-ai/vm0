const CANONICAL_SIGNING_IDENTITY = "OKOU_DESKTOP_SIGNING_IDENTITY";
const LEGACY_SIGNING_IDENTITY = "VM0_DESKTOP_SIGNING_IDENTITY";

// The production release workflow is canonical-only during this writer stage.
// Keep the legacy alias for rollback until an exact signed Desktop release
// proves two canonical-only reader events with zero legacy-only, dual, or
// conflict events, signing and notarization outputs remain unchanged, and the
// supported rollback window completes under #28914.
function resolveDesktopSigningIdentityEnvironment() {
  const canonicalValue = process.env[CANONICAL_SIGNING_IDENTITY];
  const legacyValue = process.env[LEGACY_SIGNING_IDENTITY];
  const canonicalPresent = canonicalValue !== undefined;
  const legacyPresent = legacyValue !== undefined;

  if (!canonicalPresent && !legacyPresent) {
    return undefined;
  }
  if (canonicalPresent && legacyPresent && canonicalValue !== legacyValue) {
    throw new Error(
      `Desktop signing identity environment aliases conflict: canonical_key=${CANONICAL_SIGNING_IDENTITY} legacy_key=${LEGACY_SIGNING_IDENTITY} state=conflict`,
    );
  }

  const source =
    canonicalPresent && legacyPresent
      ? "dual"
      : canonicalPresent
        ? "canonical-only"
        : "legacy-only";
  console.info(
    `desktop_signing_identity_env_source key=${CANONICAL_SIGNING_IDENTITY} source=${source}`,
  );
  return canonicalPresent ? canonicalValue : legacyValue;
}

module.exports = { resolveDesktopSigningIdentityEnvironment };
