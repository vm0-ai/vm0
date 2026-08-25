const ENVIRONMENT_ALIASES = {
  OKOU_DESKTOP_PLATFORM_URL: "VM0_DESKTOP_PLATFORM_URL",
  OKOU_DESKTOP_PRODUCT: "VM0_DESKTOP_PRODUCT",
};

function environmentValue(name) {
  return process.env[name]?.trim() || undefined;
}

// Repository writers and documentation are canonical-only. Keep the legacy
// mappings temporarily available for a unit-revert rollback of this writer/docs
// change. Remove them only after an ordinary signed Desktop release checks out a
// target containing the canonical writers, records canonical-only source
// evidence for both keys with zero legacy-only or dual evidence, completes the
// supported rollback window, and records zero legacy-use evidence under #28914.
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
