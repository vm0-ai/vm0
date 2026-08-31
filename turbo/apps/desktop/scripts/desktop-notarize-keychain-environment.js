const CANONICAL_KEYCHAIN_PROFILE = "OKOU_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE";
const LEGACY_KEYCHAIN_PROFILE = "VM0_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE";
const CANONICAL_KEYCHAIN = "OKOU_DESKTOP_NOTARIZE_KEYCHAIN";
const LEGACY_KEYCHAIN = "VM0_DESKTOP_NOTARIZE_KEYCHAIN";

function nonblankEnvironmentValue(name) {
  const value = process.env[name];
  return value?.trim() ? value : undefined;
}

function resolveEnvironmentAlias(canonicalKey, legacyKey) {
  const canonicalValue = nonblankEnvironmentValue(canonicalKey);
  const legacyValue = nonblankEnvironmentValue(legacyKey);
  const canonicalPresent = canonicalValue !== undefined;
  const legacyPresent = legacyValue !== undefined;

  if (!canonicalPresent && !legacyPresent) {
    return undefined;
  }
  if (canonicalPresent && legacyPresent && canonicalValue !== legacyValue) {
    throw new Error(
      `Desktop notarization Keychain environment aliases conflict: canonical_key=${canonicalKey} legacy_key=${legacyKey} state=conflict`,
    );
  }

  const source =
    canonicalPresent && legacyPresent
      ? "dual"
      : canonicalPresent
        ? "canonical-only"
        : "legacy-only";
  console.info(
    `desktop_notarize_keychain_env_source key=${canonicalKey} source=${source}`,
  );
  return canonicalPresent ? canonicalValue : legacyValue;
}

// Repository documentation is canonical-only for these Keychain inputs.
// Legacy aliases remain accepted for independently configured external local
// builds and unit-revert compatibility; centralized production silence is not
// a removal signal. Reader removal requires a separate explicit support-cutoff
// issue, a current inventory of team-owned external build configuration, and an
// announced breaking-change and rollback decision under #28914.
function resolveDesktopNotarizeKeychainEnvironment() {
  const keychainProfile = resolveEnvironmentAlias(
    CANONICAL_KEYCHAIN_PROFILE,
    LEGACY_KEYCHAIN_PROFILE,
  );
  if (!keychainProfile) {
    return undefined;
  }

  const keychain = resolveEnvironmentAlias(CANONICAL_KEYCHAIN, LEGACY_KEYCHAIN);
  return {
    keychainProfile,
    keychain: keychain?.trim(),
  };
}

module.exports = { resolveDesktopNotarizeKeychainEnvironment };
