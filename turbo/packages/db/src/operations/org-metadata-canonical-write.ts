import { pgTable } from "drizzle-orm/pg-core";

import { orgMetadataCanonicalColumns } from "../schema/org-metadata";

/**
 * Canonical-only application write projection for org metadata.
 *
 * The released 1033 bridge mirrors acquisition_first_party_source into
 * acquisition_vm0_source for the immediately previous application release and
 * rollback builds. Keeping the compatibility column out of this projection
 * prevents application-level dual writes.
 */
export const orgMetadataCanonicalWrites = pgTable(
  "org_metadata",
  orgMetadataCanonicalColumns(),
);
