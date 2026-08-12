import {
  WEBSITE_TEMPLATE_ARCHIVE_VERSION_ENV,
  type WebsiteTemplateArchiveVersion,
} from "@vm0/core/resource-registry";

export function websiteTemplateArchiveVersionFromEnvironment(): WebsiteTemplateArchiveVersion {
  const value = process.env[WEBSITE_TEMPLATE_ARCHIVE_VERSION_ENV];
  if (value === undefined || value === "previous") {
    return "previous";
  }
  if (value === "latest") {
    return "latest";
  }
  throw new Error(
    `${WEBSITE_TEMPLATE_ARCHIVE_VERSION_ENV} must be "latest" or "previous"`,
  );
}
