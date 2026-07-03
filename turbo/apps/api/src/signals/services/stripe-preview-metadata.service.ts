import { env, optionalEnv } from "../../lib/env";

const PREVIEW_ENVIRONMENT_METADATA_KEY = "vm0_environment";
const PREVIEW_JOB_REF_METADATA_KEY = "job_ref";

function stripePreviewJobRef(): string | null {
  if (env("ENV") !== "preview") {
    return null;
  }
  return optionalEnv("VM0_PREVIEW_JOB_REF") ?? null;
}

export function stripePreviewMetadata(): Record<string, string> {
  const jobRef = stripePreviewJobRef();
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
  const jobRef = stripePreviewJobRef();
  if (!jobRef) {
    return true;
  }
  return (
    metadata?.[PREVIEW_ENVIRONMENT_METADATA_KEY] === "preview" &&
    metadata[PREVIEW_JOB_REF_METADATA_KEY] === jobRef
  );
}
