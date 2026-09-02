import { env, optionalEnv } from "../../lib/env";

const PREVIEW_ENVIRONMENT_METADATA_KEY = "vm0_environment";
const PREVIEW_JOB_REF_METADATA_KEY = "job_ref";
const PREVIEW_JOB_REF_ENV_KEY = "OKOU_PREVIEW_JOB_REF";

function resolveStripePreviewJobRef(): string | null {
  if (env("ENV") !== "preview") {
    return null;
  }
  return optionalEnv(PREVIEW_JOB_REF_ENV_KEY) ?? null;
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
