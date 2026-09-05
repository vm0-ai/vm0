import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assertEveryBoundaryCategoryHasRule,
  assertResidualBrandNameBaseline,
  assertResidualBrandNameInventory,
  brandWordsIn,
  buildResidualBrandNameReport,
  classifyBrandOccurrences,
  collectBrandInventory,
  matchBrandBoundaryRule,
  repositoryRootFrom,
  type BrandInventory,
  type BrandOccurrence,
} from "./residual-brand-name-inventory";
import {
  RESIDUAL_BRAND_BOUNDARY_FILE_RULES,
  RESIDUAL_BRAND_BOUNDARY_OCCURRENCE_RULES,
  RESIDUAL_BRAND_NAME_BASELINE,
  type ResidualBrandNameBaselineEntry,
} from "./residual-brand-name-manifest";

const dirname = path.dirname(fileURLToPath(import.meta.url));

function occurrence(args: {
  readonly file: string;
  readonly text: string;
  readonly token: string;
}): BrandOccurrence {
  const column = args.text.indexOf(args.token) + 1;
  return { ...args, column, line: 1 };
}

function baselineEntry(name: string): ResidualBrandNameBaselineEntry {
  return {
    name,
    ownerIssue: "#31801",
    reason:
      "The synthetic entry exercises the residual brand-name ratchet in this test.",
    workstream: "R5",
  };
}

function guardInput(args: {
  readonly baseline: readonly ResidualBrandNameBaselineEntry[];
  readonly occurrences: readonly BrandOccurrence[];
}) {
  return {
    baseline: args.baseline,
    databaseIdentifiers: [],
    occurrenceRules: RESIDUAL_BRAND_BOUNDARY_OCCURRENCE_RULES,
    occurrences: args.occurrences,
    skippedFiles: [],
  };
}

let inventory: BrandInventory;

beforeAll(() => {
  inventory = collectBrandInventory({
    fileRules: RESIDUAL_BRAND_BOUNDARY_FILE_RULES,
    repositoryRoot: repositoryRootFrom(dirname),
  });
});

describe("residual brand-name ratchet", () => {
  it("classifies every tracked brand name as an approved boundary or a baselined candidate", () => {
    const classification = assertResidualBrandNameInventory({
      baseline: RESIDUAL_BRAND_NAME_BASELINE,
      databaseIdentifiers: inventory.databaseIdentifiers,
      occurrenceRules: RESIDUAL_BRAND_BOUNDARY_OCCURRENCE_RULES,
      occurrences: inventory.occurrences,
      skippedFiles: inventory.skippedFiles,
    });

    expect(inventory.occurrences.length).toBeGreaterThan(0);
    expect(classification.boundaryOccurrenceCounts.length).toBeGreaterThan(0);
  });

  it("fails on a new unclassified brand name", () => {
    const invented = occurrence({
      file: "turbo/apps/api/src/signals/services/agent-run-create.service.ts",
      text: "  const actor = await createVm0Signal(runId);",
      token: "createVm0Signal",
    });

    expect(() => {
      return assertResidualBrandNameInventory(
        guardInput({ baseline: [], occurrences: [invented] }),
      );
    }).toThrow(
      /Unclassified brand names \(1\):\n- createVm0Signal \(1 occurrences\)\n {4}turbo\/apps\/api\/src\/signals\/services\/agent-run-create\.service\.ts:1/u,
    );
  });

  it("fails on a baseline entry whose occurrences are gone", () => {
    expect(() => {
      return assertResidualBrandNameInventory(
        guardInput({
          baseline: [baselineEntry("zeroRetiredFixture")],
          occurrences: [],
        }),
      );
    }).toThrow(
      /Stale baseline entries \(1\):\n- zeroRetiredFixture \(R5, #31801\): no occurrence remains, delete the baseline entry/u,
    );
  });

  it("accepts a new name once the baseline records an owner and a reason", () => {
    const invented = occurrence({
      file: "turbo/apps/api/src/signals/services/agent-run-create.service.ts",
      text: "  const actor = await createVm0Signal(runId);",
      token: "createVm0Signal",
    });

    expect(() => {
      return assertResidualBrandNameInventory(
        guardInput({
          baseline: [baselineEntry("createVm0Signal")],
          occurrences: [invented],
        }),
      );
    }).not.toThrow();
  });

  it("rejects a baseline entry without an owning workstream and a usable reason", () => {
    expect(() => {
      return assertResidualBrandNameBaseline([
        { ...baselineEntry("zeroThing"), workstream: "R42" },
      ]);
    }).toThrow(/unknown workstream R42/u);

    expect(() => {
      return assertResidualBrandNameBaseline([
        { ...baselineEntry("zeroThing"), reason: "later" },
      ]);
    }).toThrow(/reason must explain the remaining work/u);

    expect(() => {
      return assertResidualBrandNameBaseline([
        baselineEntry("zeroThing"),
        baselineEntry("zeroThing"),
      ]);
    }).toThrow(/duplicate baseline entry/u);
  });
});

describe("residual brand-name classifier", () => {
  it("reads a brand name only at a word boundary", () => {
    expect(brandWordsIn("createVm0Run")).toEqual(["Vm0"]);
    expect(brandWordsIn("zero_runs")).toEqual(["zero"]);
    expect(brandWordsIn("restricted_vm0_models")).toEqual(["vm0"]);
    expect(brandWordsIn("normalizeRouteBindings")).toEqual([]);
    expect(brandWordsIn("serializeRow")).toEqual([]);
  });

  it("names the boundary category for every approved occurrence", () => {
    const approved = [
      {
        expected: "physical-schema-identity",
        occurrence: occurrence({
          file: "turbo/apps/api/src/signals/routes/runs.ts",
          text: "  await db.execute(sql`select id from zero_runs`);",
          token: "zero_runs",
        }),
      },
      {
        expected: "wire-and-persisted-value",
        occurrence: occurrence({
          file: "turbo/apps/api/src/signals/routes/runs.ts",
          text: '  const profile = "vm0/default";',
          token: "vm0",
        }),
      },
      {
        expected: "wire-and-persisted-value",
        occurrence: occurrence({
          file: "turbo/apps/api/src/lib/callback-route/callback-route.ts",
          text: '  headers.set("x-vm0-signature", signature);',
          token: "x-vm0-signature",
        }),
      },
      {
        expected: "persisted-artifact-provenance",
        occurrence: occurrence({
          file: "turbo/apps/api/src/signals/services/artifact-catalog.service.ts",
          text: '  const marker = "zero-official-image";',
          token: "zero-official-image",
        }),
      },
      {
        expected: "dual-brand-product-contract",
        occurrence: occurrence({
          file: "turbo/apps/api/src/signals/routes/chat-threads.ts",
          text: '  const publicBrand = brand === "vm0" ? "vm0" : "okou";',
          token: "vm0",
        }),
      },
      {
        expected: "protocol-compatibility",
        occurrence: occurrence({
          file: "turbo/apps/api/src/signals/routes/runs.ts",
          text: '  app.get("/api/zero/runs", listRuns);',
          token: "zero",
        }),
      },
      {
        expected: "external-identity",
        occurrence: occurrence({
          file: "turbo/apps/api/src/lib/env.ts",
          text: '  const origin = "https://api.vm0.ai";',
          token: "vm0",
        }),
      },
      {
        expected: "semantic-non-brand",
        occurrence: occurrence({
          file: "turbo/apps/api/src/lib/db-instrumentation.ts",
          text: "  // waitingCount is the zero-based queue position",
          token: "zero-based",
        }),
      },
    ] as const;

    expect(
      approved.map((example) => {
        return matchBrandBoundaryRule({
          databaseIdentifiers: ["zero_runs"],
          occurrence: example.occurrence,
          rules: RESIDUAL_BRAND_BOUNDARY_OCCURRENCE_RULES,
        })?.category;
      }),
    ).toEqual(
      approved.map((example) => {
        return example.expected;
      }),
    );
  });

  it("encodes a rule for every boundary category in #31813", () => {
    assertEveryBoundaryCategoryHasRule({
      fileRules: RESIDUAL_BRAND_BOUNDARY_FILE_RULES,
      occurrenceRules: RESIDUAL_BRAND_BOUNDARY_OCCURRENCE_RULES,
    });

    const categories = new Set(
      inventory.skippedFiles.map((skipped) => {
        return skipped.category;
      }),
    );
    expect(categories.has("out-of-scope")).toBe(true);
    expect(categories.has("immutable-history")).toBe(true);
  });

  it("refuses to report against a baseline it cannot attribute", () => {
    expect(() => {
      return buildResidualBrandNameReport({
        baseline: [{ ...baselineEntry("zeroThing"), workstream: "R42" }],
        classification: { boundaryOccurrenceCounts: [], residual: [] },
        skippedFiles: [],
      });
    }).toThrow(/unknown workstream R42/u);
  });

  it("produces the same report for the same input", () => {
    const classification = classifyBrandOccurrences({
      databaseIdentifiers: inventory.databaseIdentifiers,
      occurrenceRules: RESIDUAL_BRAND_BOUNDARY_OCCURRENCE_RULES,
      occurrences: inventory.occurrences,
    });
    const report = () => {
      return buildResidualBrandNameReport({
        baseline: RESIDUAL_BRAND_NAME_BASELINE,
        classification,
        skippedFiles: inventory.skippedFiles,
      });
    };

    expect(report()).toEqual(report());
    expect(report()).toContain("Unclassified names: 0");
    expect(report()).toContain(
      "- physical-schema-identity / physical-schema-identity/database-migrations:",
    );
    expect(report()).toContain(
      "- wire-and-persisted-value / wire-and-persisted-value/op-log-action-type:",
    );
  });
});
