import { env, optionalEnv } from "../../lib/env";
import { logAliasResolutionInfo, logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";

const PREVIEW_ENVIRONMENT_METADATA_KEY = "vm0_environment";
const PREVIEW_JOB_REF_METADATA_KEY = "job_ref";
const CANONICAL_PREVIEW_JOB_REF_ENV_KEY = "OKOU_PREVIEW_JOB_REF";
const LEGACY_PREVIEW_JOB_REF_ENV_KEY = "VM0_PREVIEW_JOB_REF";
const PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT =
  "stripe_preview_job_ref_alias_resolution";

const log = logger("StripePreviewMetadata");

type PreviewJobRefAliasState =
  | "absent"
  | "canonical-only"
  | "legacy-only"
  | "equal-dual"
  | "conflicting-dual";

const reportedStates = singleton(() => {
  return new Set<PreviewJobRefAliasState>();
});

function reportResolution(state: PreviewJobRefAliasState): void {
  const states = reportedStates();
  if (states.has(state)) {
    return;
  }
  states.add(state);

  const fields = {
    canonicalKey: CANONICAL_PREVIEW_JOB_REF_ENV_KEY,
    legacyKey: LEGACY_PREVIEW_JOB_REF_ENV_KEY,
    state,
  };
  if (state === "conflicting-dual") {
    log.warn(PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT, fields);
    return;
  }
  logAliasResolutionInfo(log, PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT, fields);
}

// The repository-owned preview action now emits only OKOU_PREVIEW_JOB_REF.
// This dual reader and value-free source telemetry remain for old
// checkout/rerun visibility, active old-preview compatibility, and external
// legacy input. Remove them only in a later #28914 cleanup after those sources
// and the supported rollback window are proven drained.
function resolveStripePreviewJobRef(): string | null {
  if (env("ENV") !== "preview") {
    return null;
  }

  const canonical = optionalEnv(CANONICAL_PREVIEW_JOB_REF_ENV_KEY);
  const legacy = optionalEnv(LEGACY_PREVIEW_JOB_REF_ENV_KEY);
  if (canonical && legacy && canonical !== legacy) {
    reportResolution("conflicting-dual");
    throw new Error(
      `Preview job reference aliases conflict: canonicalKey=${CANONICAL_PREVIEW_JOB_REF_ENV_KEY} legacyKey=${LEGACY_PREVIEW_JOB_REF_ENV_KEY} state=conflicting-dual`,
    );
  }

  let jobRef: string | null;
  let state: PreviewJobRefAliasState;
  if (canonical && legacy) {
    jobRef = canonical;
    state = "equal-dual";
  } else if (canonical) {
    jobRef = canonical;
    state = "canonical-only";
  } else if (legacy) {
    jobRef = legacy;
    state = "legacy-only";
  } else {
    jobRef = null;
    state = "absent";
  }

  reportResolution(state);
  return jobRef;
}

export function stripePreviewMetadata(): Record<string, string> {
  const jobRef = resolveStripePreviewJobRef();
  if (!jobRef) {
    return {};
  }
  return {
    [PREVIEW_ENVIRONMENT_METADATA_KEY]: "preview",
    [PREVIEW_JOB_REF_METADATA_KEY]: jobRef,
  };
}

export function isCurrentStripePreviewMetadata(
  metadata: Readonly<Record<string, string>> | null | undefined,
): boolean {
  const jobRef = resolveStripePreviewJobRef();
  if (!jobRef) {
    return true;
  }
  return (
    metadata?.[PREVIEW_ENVIRONMENT_METADATA_KEY] === "preview" &&
    metadata[PREVIEW_JOB_REF_METADATA_KEY] === jobRef
  );
}
