import { pgTable } from "drizzle-orm/pg-core";

import { orgMetadataCanonicalColumns } from "../schema/org-metadata";

/**
 * Canonical-only application write projection for org metadata.
 *
 * Keeping active inserts on an explicit projection pins every generated target
 * column to the canonical application contract.
 */
export const orgMetadataCanonicalWrites = pgTable(
  "org_metadata",
  orgMetadataCanonicalColumns(),
);
