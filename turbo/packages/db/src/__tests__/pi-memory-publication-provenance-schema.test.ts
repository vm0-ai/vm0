import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  PI_MEMORY_PUBLICATION_OUTCOMES,
  PI_MEMORY_PUBLICATION_WRITERS,
  piMemoryPublicationProvenance,
} from "../schema/pi-memory-publication-provenance";
import { storages } from "../schema/storage";

describe("Pi memory publication provenance schema", () => {
  it("is owner-scoped, idempotent, export-indexed, and deletion-cascaded", () => {
    const config = getTableConfig(piMemoryPublicationProvenance);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0]?.getName()).toBe(
      "pi_memory_publication_provenance_pkey",
    );

    const ownerForeignKey = config.foreignKeys.find((foreignKey) => {
      return (
        foreignKey.getName() ===
        "pi_memory_publication_provenance_storage_owner_fk"
      );
    });
    expect(ownerForeignKey?.onDelete).toBe("cascade");
    expect(ownerForeignKey?.reference().foreignTable).toBe(storages);
    expect(
      ownerForeignKey?.reference().columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["memory_storage_id", "org_id", "user_id"]);

    expect(
      config.indexes.map((index) => {
        return {
          name: index.config.name,
          unique: index.config.unique,
        };
      }),
    ).toStrictEqual([
      {
        name: "idx_pi_memory_publication_provenance_attempt",
        unique: true,
      },
      {
        name: "idx_pi_memory_publication_provenance_user_export",
        unique: false,
      },
    ]);
  });

  it("contains only the frozen bounded content-free publication fields", () => {
    expect(PI_MEMORY_PUBLICATION_WRITERS).toStrictEqual(["pi", "reconciler"]);
    expect(PI_MEMORY_PUBLICATION_OUTCOMES).toStrictEqual([
      "published",
      "conflicted",
    ]);
    expect(
      getTableConfig(piMemoryPublicationProvenance).columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual([
      "id",
      "memory_storage_id",
      "org_id",
      "user_id",
      "claimed_revision",
      "input_revision",
      "reconciliation_revision",
      "selection_digest",
      "selected_count",
      "selected_utf8_bytes",
      "base_version_id",
      "prepared_version_id",
      "observed_head_version_id",
      "writer",
      "outcome",
      "size",
      "archive_size",
      "file_count",
      "created_at",
    ]);

    const dialect = new PgDialect();
    const checks = Object.fromEntries(
      getTableConfig(piMemoryPublicationProvenance).checks.map((check) => {
        return [check.name, dialect.sqlToQuery(check.value).sql];
      }),
    );
    expect(Object.keys(checks)).toStrictEqual([
      "pi_memory_publication_provenance_revisions_check",
      "pi_memory_publication_provenance_selection_check",
      "pi_memory_publication_provenance_versions_check",
      "pi_memory_publication_provenance_writer_check",
      "pi_memory_publication_provenance_outcome_check",
      "pi_memory_publication_provenance_counts_check",
    ]);
    expect(checks.pi_memory_publication_provenance_versions_check).toContain(
      '"base_version_id" <> "pi_memory_publication_provenance"."prepared_version_id"',
    );
    expect(checks.pi_memory_publication_provenance_outcome_check).toContain(
      "observed_head_version_id",
    );
  });
});
