import { describe, expect, it } from "vitest";
import {
  certifyRecovery,
  expectedHash,
  parseMode,
  type Mode,
  type RecoveryIO,
} from "./certificate";

function cohort() {
  // Synthetic metadata from the DB boundary; no production IDs or connections.
  return {
    goals: "4162",
    threads: "4162",
    receipts: "4162",
    active: "0",
    complete: "3819",
    paused: "143",
    blocked: "200",
    nonterminal: "0",
    pending: "0",
    hash: expectedHash,
  };
}

function report(mode: Mode, repairable = 0, repaired = 0) {
  return {
    mode: mode === "apply" ? "migrate" : "dry-run",
    processed: 4162,
    counts: {
      unchanged: 4162 - repairable - repaired,
      repairable,
      repaired,
      "not-indexed": 0,
      deleted: 0,
      revoked: 0,
    },
    cursor: "00000000-0000-0000-0000-000000004162",
    complete: true,
  };
}

function output(value: unknown) {
  return { stdout: JSON.stringify(value) + "\n", stderr: "", exitCode: 0 };
}

function fixture(
  options: {
    inventories?: unknown[];
    outputs?: Awaited<ReturnType<RecoveryIO["runOperation"]>>[];
  } = {},
) {
  const records: Record<string, unknown>[] = [];
  const operations: Mode[] = [];
  let repaired = false;
  const inventories = [
    ...(options.inventories ?? [cohort(), cohort(), cohort()]),
  ];
  const outputs = options.outputs ? [...options.outputs] : undefined;
  const io: RecoveryIO = {
    readCohort: async () => {
      return inventories.shift();
    },
    runOperation: async (mode) => {
      operations.push(mode);
      if (mode === "apply") repaired = true;
      if (outputs) {
        const next = outputs.shift();
        if (!next) throw new Error("unexpected operation");
        return next;
      }
      return output(report(mode, repaired ? 0 : 2, mode === "apply" ? 2 : 0));
    },
    emit: (record) => {
      return records.push(record);
    },
  };
  return {
    io,
    records,
    operations,
    wasRepaired: () => {
      return repaired;
    },
  };
}

describe("full-cohort production recovery certificate", () => {
  it("defaults to dry-run and rejects execution overrides", () => {
    expect(parseMode([])).toBe("dry-run");
    expect(parseMode(["apply"])).toBe("apply");
    for (const args of [
      ["migrate"],
      ["apply", "--after-thread", "id"],
      [""],
      ["--max-threads=1"],
    ])
      expect(() => {
        return parseMode(args);
      }).toThrow("invalid_mode");
  });

  it("reports repairable preflight findings without writing", async () => {
    const f = fixture();
    expect(await certifyRecovery("dry-run", f.io)).toBe(true);
    expect(f.wasRepaired()).toBe(false);
    expect(f.operations).toEqual(["dry-run"]);
    expect(f.records).toContainEqual(
      expect.objectContaining({
        phase: "preflight",
        counts: expect.objectContaining({ repairable: 2 }),
      }),
    );
    expect(f.records.at(-1)).toEqual({
      mode: "dry-run",
      phase: "after",
      complete: true,
    });
  });

  it("requires fresh preflight, apply, fresh verification and final cohort", async () => {
    const f = fixture();
    expect(await certifyRecovery("apply", f.io)).toBe(true);
    expect(f.operations).toEqual(["dry-run", "apply", "dry-run"]);
    expect(
      f.records
        .filter((r) => {
          return r.hash;
        })
        .map((r) => {
          return r.phase;
        }),
    ).toEqual(["before", "before-apply", "after"]);
    expect(f.records.at(-1)).toEqual({
      mode: "apply",
      phase: "after",
      complete: true,
    });
  });

  it.each([
    ["missing inventory", undefined],
    ["empty cohort", { ...cohort(), goals: "0", threads: "0", receipts: "0" }],
    ["missing ID", { ...cohort(), goals: "4161" }],
    ["extra ID", { ...cohort(), goals: "4163" }],
    ["changed set at same count", { ...cohort(), hash: "0".repeat(64) }],
    ["incomplete receipt", { ...cohort(), receipts: "4161" }],
    ["active Goal", { ...cohort(), active: "1" }],
    ["actual nonterminal", { ...cohort(), nonterminal: "1" }],
    ["pending or reserved input", { ...cohort(), pending: "1" }],
    ["malformed count", { ...cohort(), goals: "4162suffix" }],
    ["unsafe count", { ...cohort(), goals: "9007199254740992" }],
  ])("stops before any operation on %s", async (_name, inventory) => {
    const f = fixture({ inventories: [inventory] });
    expect(await certifyRecovery("apply", f.io)).toBe(false);
    expect(f.wasRepaired()).toBe(false);
    expect(f.operations).toEqual([]);
    expect(f.records.at(-1)).toMatchObject({ complete: false });
  });

  const valid = report("dry-run");
  const badOutputs = [
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: JSON.stringify(valid), stderr: "", exitCode: 0 },
    { stdout: "not-json\n", stderr: "", exitCode: 0 },
    {
      ...output(valid),
      stdout: output(valid).stdout.replace(
        '"complete":true',
        '"complete":false,"complete":true',
      ),
    },
    { ...output(valid), stdout: output(valid).stdout + "partial garbage\n" },
    { ...output(valid), stdout: "garbage\n" + output(valid).stdout },
    output({ ...valid, complete: false }),
    output({
      ...valid,
      processed: 0,
      counts: { ...valid.counts, unchanged: 0 },
      cursor: null,
    }),
    output({
      ...valid,
      processed: 4161,
      counts: { ...valid.counts, unchanged: 4161 },
    }),
    output({ ...valid, counts: { ...valid.counts, unchanged: 4161 } }),
    output({ ...valid, counts: { ...valid.counts, error: 1 } }),
    output({ ...valid, counts: { ...valid.counts, unchanged: "4162" } }),
    output({ ...valid, errors: [] }),
    output({ ...valid, complete: "true" }),
    output({ ...valid, mode: "migrate" }),
    { ...output(valid), exitCode: 1 },
    { ...output(valid), exitCode: null },
    { ...output(valid), stderr: "SECRET SQL objective\n" },
    ...["not-indexed", "deleted", "revoked", "repaired"].map((key) => {
      return output({
        ...valid,
        counts: { ...valid.counts, unchanged: 4161, [key]: 1 },
      });
    }),
  ];
  it.each(
    badOutputs.map((value, i) => {
      return [i, value] as const;
    }),
  )("failed preflight %i never applies", async (_i, bad) => {
    const f = fixture({ outputs: [bad] });
    expect(await certifyRecovery("apply", f.io)).toBe(false);
    expect(f.wasRepaired()).toBe(false);
    expect(f.operations).toEqual(["dry-run"]);
    expect(f.records.at(-1)).toMatchObject({
      phase: "preflight",
      complete: false,
    });
    expect(JSON.stringify(f.records)).not.toContain("SECRET");
    expect(JSON.stringify(f.records)).not.toContain("garbage");
  });

  it("accepts ordered progress only with the actual full final report", async () => {
    const progress = {
      ...valid,
      processed: 100,
      counts: { ...valid.counts, unchanged: 100 },
      complete: false,
      cursor: "00000000-0000-0000-0000-000000000100",
    };
    const f = fixture({
      outputs: [
        {
          ...output(valid),
          stdout:
            output(progress).stdout +
            output({ ...valid, complete: false }).stdout +
            output(valid).stdout,
        },
      ],
    });
    expect(await certifyRecovery("dry-run", f.io)).toBe(true);
  });

  it("rejects a trailing report after complete, even if both claim success", async () => {
    const f = fixture({
      outputs: [{ ...output(valid), stdout: output(valid).stdout.repeat(2) }],
    });
    expect(await certifyRecovery("apply", f.io)).toBe(false);
    expect(f.wasRepaired()).toBe(false);
  });

  it("detects a clear during preflight before applying", async () => {
    const f = fixture({
      inventories: [cohort(), { ...cohort(), receipts: "4161" }],
    });
    expect(await certifyRecovery("apply", f.io)).toBe(false);
    expect(f.wasRepaired()).toBe(false);
    expect(f.records.at(-1)).toMatchObject({
      phase: "before-apply",
      errorClass: "cohort_mismatch",
    });
  });

  it.each([report("apply", 1), { ...report("apply"), complete: false }])(
    "rejects invalid apply completion and never retries",
    async (bad) => {
      const f = fixture({ outputs: [output(valid), output(bad)] });
      expect(await certifyRecovery("apply", f.io)).toBe(false);
      expect(f.operations).toEqual(["dry-run", "apply"]);
      expect(f.records.at(-1)).toMatchObject({
        phase: "apply",
        complete: false,
      });
    },
  );

  it.each([
    report("dry-run", 1),
    {
      ...valid,
      counts: { ...valid.counts, unchanged: 4161, "not-indexed": 1 },
    },
  ])("cannot certify remaining work after committed repairs", async (bad) => {
    const f = fixture({
      outputs: [output(valid), output(report("apply", 0, 2)), output(bad)],
    });
    expect(await certifyRecovery("apply", f.io)).toBe(false);
    expect(f.wasRepaired()).toBe(true);
    expect(f.operations).toEqual(["dry-run", "apply", "dry-run"]);
    expect(f.records.at(-1)).toMatchObject({
      phase: "verify",
      complete: false,
    });
  });

  it("fails final certification on changed cohort while preserving committed repairs", async () => {
    const changed = {
      ...cohort(),
      goals: "4161",
      receipts: "4161",
      hash: "a".repeat(64),
    };
    const f = fixture({ inventories: [cohort(), cohort(), changed] });
    expect(await certifyRecovery("apply", f.io)).toBe(false);
    expect(f.wasRepaired()).toBe(true);
    expect(f.records).toContainEqual(
      expect.objectContaining({
        phase: "after",
        hash: changed.hash,
        counts: expect.objectContaining({ goals: 4161 }),
      }),
    );
    expect(f.records.at(-1)).toMatchObject({
      phase: "after",
      errorClass: "cohort_mismatch",
      complete: false,
    });
  });

  it("sanitizes dependency exceptions", async () => {
    const f = fixture();
    f.io.runOperation = async () => {
      throw new Error("SECRET provider response");
    };
    expect(await certifyRecovery("apply", f.io)).toBe(false);
    expect(JSON.stringify(f.records)).not.toContain("SECRET");
    expect(f.wasRepaired()).toBe(false);
  });
});
