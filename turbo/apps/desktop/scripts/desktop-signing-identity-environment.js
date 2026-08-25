const CANONICAL_SIGNING_IDENTITY = "OKOU_DESKTOP_SIGNING_IDENTITY";
const LEGACY_SIGNING_IDENTITY = "VM0_DESKTOP_SIGNING_IDENTITY";

// The production release workflow remains legacy-only during this reader
// stage. Remove the legacy alias only after an ordinary signed Desktop release
// proves legacy-only evidence from both readers, a later writer cutover records
// canonical-only production evidence, and the supported rollback window plus
// zero legacy-use gate complete under #28914.
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
