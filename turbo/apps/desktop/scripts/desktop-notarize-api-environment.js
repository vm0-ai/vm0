const CREDENTIAL_ALIASES = [
  {
    canonical: "OKOU_DESKTOP_NOTARIZE_API_KEY_PATH",
    legacy: "VM0_DESKTOP_NOTARIZE_API_KEY_PATH",
    option: "appleApiKey",
  },
  {
    canonical: "OKOU_DESKTOP_NOTARIZE_API_KEY_ID",
    legacy: "VM0_DESKTOP_NOTARIZE_API_KEY_ID",
    option: "appleApiKeyId",
  },
  {
    canonical: "OKOU_DESKTOP_NOTARIZE_API_ISSUER",
    legacy: "VM0_DESKTOP_NOTARIZE_API_ISSUER",
    option: "appleApiIssuer",
  },
];

function presentEnvironmentValue(name) {
  return process.env[name] || undefined;
}

function aliasState(values) {
  return CREDENTIAL_ALIASES.flatMap((alias, index) => [
    `${alias.canonical}=${values.canonical[index] ? "present" : "absent"}`,
    `${alias.legacy}=${values.legacy[index] ? "present" : "absent"}`,
  ]).join(" ");
}

function resolvedOptions(source, values) {
  console.info(`desktop_notarize_api_env_source source=${source}`);
  return Object.fromEntries(
    CREDENTIAL_ALIASES.map((alias, index) => [alias.option, values[index]]),
  );
}

// The release workflow and documented local-build surface remain legacy-only
// during reader Stage 1. Remove these aliases only after #28914 atomically
// cuts the writer and docs over, preserves the rollback window, and records
// zero legacy-only source evidence.
function resolveDesktopNotarizeApiEnvironment() {
  const values = {
    canonical: CREDENTIAL_ALIASES.map((alias) =>
      presentEnvironmentValue(alias.canonical),
    ),
    legacy: CREDENTIAL_ALIASES.map((alias) =>
      presentEnvironmentValue(alias.legacy),
    ),
  };
  const canonicalCount = values.canonical.filter(Boolean).length;
  const legacyCount = values.legacy.filter(Boolean).length;

  if (canonicalCount === 0 && legacyCount === 0) {
    return undefined;
  }
  if (canonicalCount === CREDENTIAL_ALIASES.length && legacyCount === 0) {
    return resolvedOptions("canonical-only", values.canonical);
  }
  if (canonicalCount === 0 && legacyCount === CREDENTIAL_ALIASES.length) {
    return resolvedOptions("legacy-only", values.legacy);
  }
  if (
    canonicalCount === CREDENTIAL_ALIASES.length &&
    legacyCount === CREDENTIAL_ALIASES.length
  ) {
    if (
      values.canonical.every((value, index) => value === values.legacy[index])
    ) {
      return resolvedOptions("dual", values.canonical);
    }
    throw new Error(
      `Desktop notarization API credential aliases conflict: state=conflict ${aliasState(values)}`,
    );
  }
  if (canonicalCount > 0 && legacyCount > 0) {
    throw new Error(
      `Desktop notarization API credentials mix canonical and legacy aliases: state=mixed ${aliasState(values)}`,
    );
  }
  throw new Error(
    `Desktop notarization API credentials are incomplete: state=incomplete ${aliasState(values)}`,
  );
}

module.exports = { resolveDesktopNotarizeApiEnvironment };
