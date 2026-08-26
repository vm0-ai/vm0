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

interface ApiBackendUrlResolution {
  readonly state: ApiBackendUrlAliasState;
  readonly value: string | undefined;
}

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

function resolveApiBackendUrl(): ApiBackendUrlResolution {
  const canonical = env(CANONICAL_API_BACKEND_URL_KEY);
  const legacy = env(LEGACY_API_BACKEND_URL_KEY);

  if (!canonical) {
    return {
      state: legacy ? "legacy-only" : "absent",
      value: legacy,
    };
  }
  if (!legacy) {
    return { state: "canonical-only", value: canonical };
  }
  if (canonical === legacy) {
    return { state: "equal-dual", value: canonical };
  }
  return { state: "conflicting-dual", value: undefined };
}

export function reportApiBackendUrlAliasSourceAtProcessInitialization(): void {
  reportResolution(resolveApiBackendUrl().state);
}

// This API-process compatibility boundary retains VM0_API_BACKEND_URL while
// repository, deployment, preview, and local writers remain legacy-only.
// Under #28914, remove the legacy input only after an exact release containing
// this reader reached every supported API runtime, the supported rollback
// target can start after writer cutover, and value-free telemetry reports zero
// legacy-only and equal-dual resolutions through that rollback window.
export function apiBackendUrl(): string | undefined {
  const resolution = resolveApiBackendUrl();
  reportResolution(resolution.state);
  if (resolution.state !== "conflicting-dual") {
    return resolution.value;
  }
  throw new Error(
    `API backend URL aliases conflict: canonicalKey=${CANONICAL_API_BACKEND_URL_KEY} legacyKey=${LEGACY_API_BACKEND_URL_KEY} state=conflicting-dual`,
  );
}
