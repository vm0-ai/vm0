import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";

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
  | "dual";

// The preview deployment action intentionally remains legacy-only during this
// reader-expansion stage. Remove the legacy alias only after #28914 completes
// writer cutover, retires pre-reader rollback targets, and observes zero
// legacy-only resolutions through the supported rollback window.
function resolveStripePreviewJobRef(): string | null {
  if (env("ENV") !== "preview") {
    return null;
  }

  const canonical = optionalEnv(CANONICAL_PREVIEW_JOB_REF_ENV_KEY);
  const legacy = optionalEnv(LEGACY_PREVIEW_JOB_REF_ENV_KEY);
  if (canonical && legacy && canonical !== legacy) {
    log.warn(PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT, {
      canonicalKey: CANONICAL_PREVIEW_JOB_REF_ENV_KEY,
      legacyKey: LEGACY_PREVIEW_JOB_REF_ENV_KEY,
      state: "dual",
    });
    throw new Error(
      `Preview job reference aliases conflict: canonicalKey=${CANONICAL_PREVIEW_JOB_REF_ENV_KEY} legacyKey=${LEGACY_PREVIEW_JOB_REF_ENV_KEY} state=dual`,
    );
  }

  let jobRef: string | null;
  let state: PreviewJobRefAliasState;
  if (canonical && legacy) {
    jobRef = canonical;
    state = "dual";
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

  log.debug(PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT, {
    canonicalKey: CANONICAL_PREVIEW_JOB_REF_ENV_KEY,
    legacyKey: LEGACY_PREVIEW_JOB_REF_ENV_KEY,
    state,
  });
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
