const CANONICAL_KEYCHAIN_PROFILE = "OKOU_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE";
const CANONICAL_KEYCHAIN = "OKOU_DESKTOP_NOTARIZE_KEYCHAIN";

function nonblankEnvironmentValue(name) {
  const value = process.env[name];
  return value?.trim() ? value : undefined;
}

function resolveDesktopNotarizeKeychainEnvironment() {
  const keychainProfile = nonblankEnvironmentValue(CANONICAL_KEYCHAIN_PROFILE);
  if (!keychainProfile) {
    return undefined;
  }

  const keychain = nonblankEnvironmentValue(CANONICAL_KEYCHAIN);
  return {
    keychainProfile,
    keychain: keychain?.trim(),
  };
}

module.exports = { resolveDesktopNotarizeKeychainEnvironment };
