import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGACY_DATABASE_IDENTITY_MANIFEST,
  type LegacyDatabaseIdentityKind,
  type LegacyDatabaseIdentityManifestEntry,
  type LegacyDatabaseIdentitySource,
} from "./legacy-database-identity-manifest";
import {
  assertLegacyDatabaseIdentityInventory,
  assertLegacyDatabaseIdentityManifest,
  assertLegacyDatabaseIdentitySourceInventory,
  discoverLatestLegacySnapshotIdentities,
  discoverLegacyCatalogIdentities,
  discoverLegacySnapshotIdentities,
  discoverPersistedSemanticLegacyIdentities,
  hasLegacyDatabaseToken,
  REPLAYED_CATALOG_RELATION_CONSTRAINT_TYPES,
  type LegacyCatalogCandidate,
} from "./legacy-database-identity-inventory";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(dirname, "../src/migrations");

function testManifestEntry(args: {
  readonly key: string;
  readonly kind: LegacyDatabaseIdentityKind;
  readonly members?: readonly string[];
  readonly sources?: readonly LegacyDatabaseIdentitySource[];
}): LegacyDatabaseIdentityManifestEntry {
  return {
    classification: "migrate",
    drainEvidence:
      "An exact zero-count query and a 7-day production window prove the legacy identity is unused.",
    key: args.key,
    kind: args.kind,
    members: args.members ?? [args.key.slice(args.key.indexOf(":") + 1)],
    ownerIssue: "#29688",
    reason: "The synthetic identity exercises the repository inventory gate.",
    removalGate:
      "#29688 permits removal only after the exact zero-count query and 7-day window both pass.",
    sources: args.sources ?? ["snapshot"],
    writerStopCondition:
      "#29688 records that every synthetic writer uses the canonical identity.",
  };
}

function catalogCandidate(args: {
  readonly evidence: string;
  readonly key: string;
  readonly kind: LegacyDatabaseIdentityKind;
  readonly matchTexts: readonly string[];
  readonly member: string;
}): LegacyCatalogCandidate {
  return {
    evidence: args.evidence,
    key: args.key,
    kind: args.kind,
    matchTexts: args.matchTexts,
    members: [args.member],
  };
}

describe("active legacy database identity inventory", () => {
  it("tracks exactly 17 retained identities after the acquisition contract", () => {
    const counts = LEGACY_DATABASE_IDENTITY_MANIFEST.reduce(
      (result, entry) => {
        result[entry.classification] += 1;
        return result;
      },
      { migrate: 0, retain: 0 },
    );
    expect({
      total: LEGACY_DATABASE_IDENTITY_MANIFEST.length,
      ...counts,
    }).toEqual({ total: 17, migrate: 0, retain: 17 });

    expect(
      LEGACY_DATABASE_IDENTITY_MANIFEST.filter((entry) => {
        return entry.classification === "migrate";
      }).map((entry) => {
        return entry.key;
      }),
    ).toEqual([]);

    const removedAcquisitionKeys = [
      "column:public.org_metadata.acquisition_vm0_source",
      "function:public.sync_org_metadata_acquisition_first_party_source_1033()",
      "trigger:public.org_metadata.sync_org_metadata_acquisition_first_party_source_1033",
    ];
    expect(
      LEGACY_DATABASE_IDENTITY_MANIFEST.filter((entry) => {
        return removedAcquisitionKeys.includes(entry.key);
      }),
    ).toEqual([]);

    const removedEntitlementKeys = [
      "column:public.org_plan_entitlements.restricted_vm0_models",
      "function:public.ensure_legacy_org_metadata_plan_entitlement()",
      "function:public.sync_org_plan_entitlement_model_restrictions_1023()",
      "trigger:public.org_plan_entitlements.sync_org_plan_entitlement_model_restrictions_1023",
    ];
    expect(
      LEGACY_DATABASE_IDENTITY_MANIFEST.filter((entry) => {
        return removedEntitlementKeys.includes(entry.key);
      }),
    ).toEqual([]);

    expect(
      LEGACY_DATABASE_IDENTITY_MANIFEST.filter((entry) => {
        return entry.sources.some((source) => {
          return source === "snapshot";
        });
      }),
    ).toHaveLength(14);
  });

  it("matches the journal-selected current snapshot and semantic contracts exactly", async () => {
    const latest =
      await discoverLatestLegacySnapshotIdentities(migrationsDirectory);
    expect(() => {
      assertLegacyDatabaseIdentitySourceInventory({
        discovered: latest.identities,
        manifest: LEGACY_DATABASE_IDENTITY_MANIFEST,
        source: "snapshot",
      });
    }).not.toThrow();

    const semanticContracts = discoverPersistedSemanticLegacyIdentities(
      latest.snapshot,
    );
    expect(() => {
      assertLegacyDatabaseIdentitySourceInventory({
        discovered: semanticContracts,
        manifest: LEGACY_DATABASE_IDENTITY_MANIFEST,
        source: "semantic-contract",
      });
    }).not.toThrow();
  });

  it("keeps ordinary replay constraints complete without counting backing indexes", () => {
    expect(REPLAYED_CATALOG_RELATION_CONSTRAINT_TYPES).toEqual(
      expect.arrayContaining(["p", "u", "x"]),
    );

    const expectedPrimaryKeys = LEGACY_DATABASE_IDENTITY_MANIFEST.flatMap(
      (entry) => {
        if (entry.kind !== "relation" || entry.ownerIssue !== "#26896") {
          return [];
        }
        const relationMember = entry.members[0];
        if (!relationMember) return [];
        const tableName = relationMember.slice(
          relationMember.lastIndexOf(".") + 1,
        );
        return [`constraint:${relationMember}.${tableName}_pkey`];
      },
    ).sort();
    const replayedPrimaryKeys = LEGACY_DATABASE_IDENTITY_MANIFEST.filter(
      (entry) => {
        return (
          entry.kind === "constraint" &&
          entry.sources.length === 1 &&
          entry.sources[0] === "catalog" &&
          entry.key.endsWith("_pkey")
        );
      },
    )
      .map((entry) => {
        return entry.key;
      })
      .sort();

    expect(replayedPrimaryKeys).toEqual(expectedPrimaryKeys);
    expect(
      LEGACY_DATABASE_IDENTITY_MANIFEST.filter((entry) => {
        return entry.kind === "index" && entry.key.endsWith("_pkey");
      }),
    ).toEqual([]);
  });

  it("ignores historical snapshots that are not selected by the journal tail", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "legacy-database-identity-"),
    );
    const metaDirectory = path.join(temporaryDirectory, "meta");
    await fs.mkdir(metaDirectory);

    try {
      await fs.writeFile(
        path.join(metaDirectory, "_journal.json"),
        JSON.stringify({
          entries: [
            { idx: 1, tag: "0001_historical" },
            { idx: 2, tag: "0002_current" },
          ],
        }),
      );
      await fs.writeFile(
        path.join(metaDirectory, "0001_snapshot.json"),
        JSON.stringify({
          enums: {},
          tables: {
            "public.zero_historical_records": {
              columns: {},
              name: "zero_historical_records",
              schema: "",
            },
          },
          views: {},
        }),
      );
      await fs.writeFile(
        path.join(metaDirectory, "0002_snapshot.json"),
        JSON.stringify({
          enums: {},
          tables: {
            "public.current_records": {
              columns: {},
              name: "current_records",
              schema: "",
            },
          },
          views: {},
        }),
      );

      const latest =
        await discoverLatestLegacySnapshotIdentities(temporaryDirectory);
      expect(latest.migrationTag).toBe("0002_current");
      expect(latest.identities).toEqual([]);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("reports an unclassified relation, column, and default", () => {
    const discovered = discoverLegacySnapshotIdentities({
      enums: {},
      tables: {
        "public.zero_new_records": {
          checkConstraints: {},
          columns: {
            acquisition_vm0_flag: {
              default: "'zero'",
              name: "acquisition_vm0_flag",
            },
          },
          foreignKeys: {},
          indexes: {},
          name: "zero_new_records",
          policies: {},
          schema: "",
        },
      },
      views: {},
    });

    expect(() => {
      assertLegacyDatabaseIdentitySourceInventory({
        discovered,
        manifest: [],
        source: "snapshot",
      });
    }).toThrowError(/relation:public\.zero_new_records/u);
    expect(() => {
      assertLegacyDatabaseIdentitySourceInventory({
        discovered,
        manifest: [],
        source: "snapshot",
      });
    }).toThrowError(/column:public\.zero_new_records\.acquisition_vm0_flag/u);
    expect(() => {
      assertLegacyDatabaseIdentitySourceInventory({
        discovered,
        manifest: [],
        source: "snapshot",
      });
    }).toThrowError(/default:public\.zero_new_records\.acquisition_vm0_flag/u);
  });

  it("reports unclassified persisted values from schema-backed contracts", () => {
    const snapshot = {
      enums: {},
      tables: {
        "public.agent_runs": {
          columns: { model_provider: { name: "model_provider" } },
          name: "agent_runs",
          schema: "",
        },
        "public.brand_records": {
          columns: { public_brand: { name: "public_brand" } },
          name: "brand_records",
          schema: "",
        },
        "public.computer_use_hosts": {
          columns: { client_product: { name: "client_product" } },
          name: "computer_use_hosts",
          schema: "",
        },
        "public.runner_job_queue": {
          columns: { profile: { name: "profile" } },
          name: "runner_job_queue",
          schema: "",
        },
      },
      views: {},
    };
    const discovered = discoverPersistedSemanticLegacyIdentities(snapshot);

    expect(() => {
      assertLegacyDatabaseIdentitySourceInventory({
        discovered,
        manifest: [],
        source: "semantic-contract",
      });
    }).toThrowError(/enum-discriminator-value:contract\.public-brand = 'vm0'/u);
  });

  it("reports unclassified replay-only views and functions", () => {
    const discovered = discoverLegacyCatalogIdentities([
      catalogCandidate({
        evidence: "catalog:relation:v:public.current_view",
        key: "view:public.current_view",
        kind: "view",
        matchTexts: ["current_view", "SELECT * FROM zero_records"],
        member: "public.current_view",
      }),
      catalogCandidate({
        evidence: "catalog:function:public.current_writer()",
        key: "function:public.current_writer()",
        kind: "function",
        matchTexts: [
          "current_writer",
          "CREATE FUNCTION current_writer() RETURNS trigger AS 'SELECT vm0'",
        ],
        member: "public.current_writer()",
      }),
    ]);

    expect(() => {
      assertLegacyDatabaseIdentitySourceInventory({
        discovered,
        manifest: [],
        source: "catalog",
      });
    }).toThrowError(/view:public\.current_view/u);
    expect(() => {
      assertLegacyDatabaseIdentitySourceInventory({
        discovered,
        manifest: [],
        source: "catalog",
      });
    }).toThrowError(/function:public\.current_writer\(\)/u);
  });

  it("reports stale manifest entries and source disagreements", () => {
    const entry = testManifestEntry({
      key: "relation:public.zero_expected_records",
      kind: "relation",
      sources: ["snapshot", "catalog"],
    });
    expect(() => {
      assertLegacyDatabaseIdentityInventory({
        discovered: [],
        manifest: [entry],
      });
    }).toThrowError(/Manifest entries missing from current state/u);

    const snapshotOnly = discoverLegacySnapshotIdentities({
      enums: {},
      tables: {
        "public.zero_expected_records": {
          columns: {},
          name: "zero_expected_records",
          schema: "",
        },
      },
      views: {},
    });
    expect(() => {
      assertLegacyDatabaseIdentityInventory({
        discovered: snapshotOnly,
        manifest: [entry],
      });
    }).toThrowError(
      /expected sources \[catalog, snapshot\], discovered \[snapshot\]/u,
    );
  });

  it("rejects duplicate keys, wildcard members, and incomplete metadata", () => {
    const entry = testManifestEntry({
      key: "relation:public.zero_records",
      kind: "relation",
    });
    expect(() => {
      assertLegacyDatabaseIdentityManifest([entry, entry]);
    }).toThrowError(/duplicate key/u);

    expect(() => {
      assertLegacyDatabaseIdentityManifest([
        testManifestEntry({
          key: "relation:public.zero_records",
          kind: "relation",
          members: ["public.zero_*"],
        }),
      ]);
    }).toThrowError(/wildcard member/u);

    expect(() => {
      assertLegacyDatabaseIdentityManifest([
        { ...entry, removalGate: "later" },
      ]);
    }).toThrowError(/non-measurable language/u);
    expect(() => {
      assertLegacyDatabaseIdentityManifest([
        {
          ...entry,
          writerStopCondition: "The owner issue #29688 records the decision.",
        },
      ]);
    }).toThrowError(/writerStopCondition has no measurable condition/u);
    expect(() => {
      assertLegacyDatabaseIdentityManifest([{ ...entry, reason: "" }]);
    }).toThrowError(/reason is empty/u);
  });

  it("rejects overlapping semantic family membership", () => {
    const member = "public.records.public_brand = 'vm0'";
    expect(() => {
      assertLegacyDatabaseIdentityManifest([
        testManifestEntry({
          key: "enum-discriminator-value:contract.first = 'vm0'",
          kind: "enum-discriminator-value",
          members: [member],
          sources: ["semantic-contract"],
        }),
        testManifestEntry({
          key: "enum-discriminator-value:contract.second = 'vm0'",
          kind: "enum-discriminator-value",
          members: [member],
          sources: ["semantic-contract"],
        }),
      ]);
    }).toThrowError(/overlapping semantic families/u);
  });

  it("assigns the retained Runner profile protocol to its protocol owner", () => {
    const runnerProfileEntry = LEGACY_DATABASE_IDENTITY_MANIFEST.find(
      (entry) => {
        return (
          entry.key ===
          "enum-discriminator-value:contract.runner-profile = 'vm0/default'"
        );
      },
    );

    expect(runnerProfileEntry).toMatchObject({
      classification: "retain",
      ownerIssue: "#26701",
    });
    expect(runnerProfileEntry?.writerStopCondition).toContain("#26701");
    expect(runnerProfileEntry?.drainEvidence).toContain("#26701");
    expect(runnerProfileEntry?.removalGate).toContain("#26701");
  });

  it.each([
    "zero_workflows",
    "acquisition_vm0_source",
    "vm0/default",
    "'vm0'",
    '"zero"',
  ])("matches the complete legacy token in %s", (value) => {
    expect(hasLegacyDatabaseToken(value)).toBe(true);
  });

  it.each(["remove", "zeroed", "vm01", "vm0api", "timezone"])(
    "ignores the unrelated substring in %s",
    (value) => {
      expect(hasLegacyDatabaseToken(value)).toBe(false);
    },
  );

  it("deduplicates one catalog object matched by name, definition, rule, and dependency", () => {
    const key = "view:public.zero_current_view";
    const member = "public.zero_current_view";
    const discovered = discoverLegacyCatalogIdentities([
      catalogCandidate({
        evidence: "catalog:relation:v:public.zero_current_view",
        key,
        kind: "view",
        matchTexts: ["zero_current_view"],
        member,
      }),
      catalogCandidate({
        evidence: "catalog:rule:public.zero_current_view._RETURN",
        key,
        kind: "view",
        matchTexts: ["SELECT * FROM zero_records"],
        member,
      }),
      catalogCandidate({
        evidence:
          "catalog:dependency:public.zero_current_view->public.zero_records",
        key,
        kind: "view",
        matchTexts: ["zero_records"],
        member,
      }),
    ]);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.evidence).toHaveLength(3);
    expect(() => {
      assertLegacyDatabaseIdentityInventory({
        discovered,
        manifest: [
          testManifestEntry({
            key,
            kind: "view",
            sources: ["catalog"],
          }),
        ],
      });
    }).not.toThrow();
  });
});
