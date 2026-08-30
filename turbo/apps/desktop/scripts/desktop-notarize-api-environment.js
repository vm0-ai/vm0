function resolveDesktopNotarizeApiEnvironment() {
  const appleApiKey =
    process.env.OKOU_DESKTOP_NOTARIZE_API_KEY_PATH || undefined;
  const appleApiKeyId =
    process.env.OKOU_DESKTOP_NOTARIZE_API_KEY_ID || undefined;
  const appleApiIssuer =
    process.env.OKOU_DESKTOP_NOTARIZE_API_ISSUER || undefined;

  if (!appleApiKey && !appleApiKeyId && !appleApiIssuer) {
    return undefined;
  }
  if (!appleApiKey || !appleApiKeyId || !appleApiIssuer) {
    throw new Error(
      "Desktop notarization API credentials are incomplete: state=incomplete",
    );
  }

  return { appleApiKey, appleApiKeyId, appleApiIssuer };
}

module.exports = { resolveDesktopNotarizeApiEnvironment };
