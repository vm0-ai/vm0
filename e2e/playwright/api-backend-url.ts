const CANONICAL_API_BACKEND_URL_KEY = "OKOU_API_BACKEND_URL";
const LEGACY_API_BACKEND_URL_KEY = "VM0_API_BACKEND_URL";

type ApiBackendUrlEnvironment = Readonly<Record<string, string | undefined>>;

// Repository E2E writers are canonical-only during this compatibility stage.
// Keep the legacy development, preview, and operational rollback input until
// its documented support cutoff is approved and no supported rollback or
// invocation contract needs it. The removal gate is tracked by #28914.
export function resolveApiBackendUrl(
  environment: ApiBackendUrlEnvironment = process.env,
): string {
  const canonicalValue = environment[CANONICAL_API_BACKEND_URL_KEY];
  const legacyValue = environment[LEGACY_API_BACKEND_URL_KEY];

  if (canonicalValue && legacyValue && canonicalValue !== legacyValue) {
    throw new Error(
      `E2E API backend URL aliases conflict: canonical_key=${CANONICAL_API_BACKEND_URL_KEY} legacy_key=${LEGACY_API_BACKEND_URL_KEY} state=conflict`,
    );
  }

  const value = canonicalValue || legacyValue;
  if (!value) {
    throw new Error(
      `E2E API backend URL is required: canonical_key=${CANONICAL_API_BACKEND_URL_KEY} legacy_key=${LEGACY_API_BACKEND_URL_KEY} state=missing`,
    );
  }
  return value;
}
