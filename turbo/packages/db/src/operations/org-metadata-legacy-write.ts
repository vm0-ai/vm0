import { pgTable } from "drizzle-orm/pg-core";

import { orgMetadataLegacyColumns } from "../schema/org-metadata";

/**
 * #30379 old-database/new-application INSERT compatibility.
 *
 * Surface: DB/API old/new schema skew, observed up to approximately 102 minutes.
 * Drizzle includes every mapped column in an INSERT target list, including
 * omitted nullable columns as DEFAULT. Keep active inserts on this legacy-only
 * projection until #28368 records that the pre-expand schema is outside every
 * supported deployment and rollback target.
 */
export const orgMetadataLegacyWrites = pgTable(
  "org_metadata",
  orgMetadataLegacyColumns(),
);
