const ENVIRONMENT_ALIASES = {
  OKOU_DESKTOP_PLATFORM_URL: "VM0_DESKTOP_PLATFORM_URL",
  OKOU_DESKTOP_PRODUCT: "VM0_DESKTOP_PRODUCT",
};

function environmentValue(name) {
  return process.env[name]?.trim() || undefined;
}

// Repository writers and supported local inputs remain legacy-only during
// reader Stage 1. Remove the legacy mappings only after #28914 cuts every
// writer over, preserves the rollback window, and records zero legacy source
// evidence.
function resolveDesktopEnvironmentAlias(canonicalKey) {
  const legacyKey = ENVIRONMENT_ALIASES[canonicalKey];
  const canonicalValue = environmentValue(canonicalKey);
  const legacyValue = environmentValue(legacyKey);

  if (!canonicalValue && !legacyValue) {
    return undefined;
  }
  if (canonicalValue && legacyValue && canonicalValue !== legacyValue) {
    throw new Error(
      `Desktop environment aliases conflict: key=${canonicalKey} state=conflict`,
    );
  }

  const source =
    canonicalValue && legacyValue
      ? "dual"
      : canonicalValue
        ? "canonical-only"
        : "legacy-only";
  console.info(
    `desktop_environment_alias_source key=${canonicalKey} source=${source}`,
  );
  return canonicalValue || legacyValue;
}

module.exports = { resolveDesktopEnvironmentAlias };
