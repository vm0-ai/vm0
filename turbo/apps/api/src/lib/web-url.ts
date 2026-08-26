import { env } from "./env";
import { logAliasResolutionInfo, logger } from "./log";
import { singleton } from "./singleton";

const CANONICAL_WEB_URL_KEY = "OKOU_WEB_URL";
const LEGACY_WEB_URL_KEY = "VM0_WEB_URL";
const WEB_URL_ALIAS_RESOLUTION_EVENT = "web_url_alias_resolution";
const WEB_URL_MISSING_ERROR =
  "Web URL aliases are missing: canonicalKey=OKOU_WEB_URL legacyKey=VM0_WEB_URL state=absent";
const WEB_URL_CONFLICT_ERROR =
  "Web URL aliases conflict: canonicalKey=OKOU_WEB_URL legacyKey=VM0_WEB_URL state=conflicting-dual";

type WebUrlAliasState =
  | "absent"
  | "canonical-only"
  | "legacy-only"
  | "equal-dual"
  | "conflicting-dual";

const log = logger("WebUrl");
const reportedStates = singleton(() => {
  return new Set<WebUrlAliasState>();
});

function reportResolution(state: WebUrlAliasState): void {
  const states = reportedStates();
  if (states.has(state)) {
    return;
  }
  states.add(state);

  const fields = {
    canonicalKey: CANONICAL_WEB_URL_KEY,
    legacyKey: LEGACY_WEB_URL_KEY,
    state,
  };
  if (state === "absent" || state === "conflicting-dual") {
    log.warn(WEB_URL_ALIAS_RESOLUTION_EVENT, fields);
    return;
  }
  logAliasResolutionInfo(log, WEB_URL_ALIAS_RESOLUTION_EVENT, fields);
}

// This API-process compatibility boundary retains VM0_WEB_URL while the
// deployment action and local API template emit only OKOU_WEB_URL and Turbo
// keeps both aliases in its environment pass-through. Under #28914, remove the
// legacy input only after every supported writer is canonical-only, old-only
// rollback targets are retired, and value-free telemetry reports zero
// legacy-only and equal-dual resolutions through that rollback window. Refresh
// stale Worker PR #25722 before that cutover.
export function webUrl(): string {
  const canonical = env(CANONICAL_WEB_URL_KEY);
  const legacy = env(LEGACY_WEB_URL_KEY);

  if (canonical === undefined) {
    if (legacy === undefined) {
      reportResolution("absent");
      throw new Error(WEB_URL_MISSING_ERROR);
    }
    reportResolution("legacy-only");
    return legacy;
  }
  if (legacy === undefined) {
    reportResolution("canonical-only");
    return canonical;
  }
  if (canonical === legacy) {
    reportResolution("equal-dual");
    return canonical;
  }

  reportResolution("conflicting-dual");
  throw new Error(WEB_URL_CONFLICT_ERROR);
}
