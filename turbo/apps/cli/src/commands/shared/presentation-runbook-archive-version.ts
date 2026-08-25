import {
  PRESENTATION_RUNBOOK_ARCHIVE_VERSION_ENV,
  type PresentationRunbookArchiveVersion,
} from "@okouai/core/resource-registry";

export function presentationRunbookArchiveVersionFromEnvironment(): PresentationRunbookArchiveVersion {
  const value = process.env[PRESENTATION_RUNBOOK_ARCHIVE_VERSION_ENV];
  if (value === undefined || value === "previous") {
    return "previous";
  }
  if (value === "latest") {
    return "latest";
  }
  throw new Error(
    `${PRESENTATION_RUNBOOK_ARCHIVE_VERSION_ENV} must be "latest" or "previous"`,
  );
}
