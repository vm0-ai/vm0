import { env } from "./env";
import { logAliasResolutionInfo, logger } from "./log";
import { singleton } from "./singleton";

const CANONICAL_API_BACKEND_URL_KEY = "OKOU_API_BACKEND_URL";
const LEGACY_API_BACKEND_URL_KEY = "VM0_API_BACKEND_URL";
const API_BACKEND_URL_ALIAS_RESOLUTION_EVENT =
  "api_backend_url_alias_resolution";

type ApiBackendUrlAliasState =
  | "absent"
  | "canonical-only"
  | "legacy-only"
  | "equal-dual"
  | "conflicting-dual";

const log = logger("ApiBackendUrl");
const reportedStates = singleton(() => {
  return new Set<ApiBackendUrlAliasState>();
});

function reportResolution(state: ApiBackendUrlAliasState): void {
  const states = reportedStates();
  if (states.has(state)) {
    return;
  }
  states.add(state);

  const fields = {
    canonicalKey: CANONICAL_API_BACKEND_URL_KEY,
    legacyKey: LEGACY_API_BACKEND_URL_KEY,
    state,
  };
  if (state === "conflicting-dual") {
    log.warn(API_BACKEND_URL_ALIAS_RESOLUTION_EVENT, fields);
    return;
  }
  logAliasResolutionInfo(log, API_BACKEND_URL_ALIAS_RESOLUTION_EVENT, fields);
}

// This API-process compatibility boundary retains VM0_API_BACKEND_URL while
// repository, deployment, preview, and local writers remain legacy-only.
// Under #28914, remove the legacy input only after an exact release containing
// this reader reached every supported API runtime, the supported rollback
// target can start after writer cutover, and value-free telemetry reports zero
// legacy-only and equal-dual resolutions through that rollback window.
export function apiBackendUrl(): string | undefined {
  const canonical = env(CANONICAL_API_BACKEND_URL_KEY);
  const legacy = env(LEGACY_API_BACKEND_URL_KEY);

  if (!canonical) {
    const state = legacy ? "legacy-only" : "absent";
    reportResolution(state);
    return legacy;
  }
  if (!legacy) {
    reportResolution("canonical-only");
    return canonical;
  }
  if (canonical === legacy) {
    reportResolution("equal-dual");
    return canonical;
  }

  reportResolution("conflicting-dual");
  throw new Error(
    `API backend URL aliases conflict: canonicalKey=${CANONICAL_API_BACKEND_URL_KEY} legacyKey=${LEGACY_API_BACKEND_URL_KEY} state=conflicting-dual`,
  );
}
