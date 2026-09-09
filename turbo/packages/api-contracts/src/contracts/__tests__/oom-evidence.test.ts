import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { oomEvidenceSchema } from "../oom-evidence";
import { webhookTelemetryContract } from "../webhooks";

const fixture: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../../crates/guest-contracts/tests/fixtures/oom-evidence-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

// Compared against production collector output by the Rust test
// collector_output_matches_api_fixture; paths are never normalized by tests.
const collector = z
  .object({
    initial: oomEvidenceSchema,
    sample: oomEvidenceSchema,
    cleanup: oomEvidenceSchema,
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../crates/guest-control-server/tests/fixtures/oom-evidence-collector.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

describe("OOM evidence wire compatibility", () => {
  it("accepts collector output in mixed metric batches and urgent or fallback evidence", () => {
    for (const memory of [collector.initial, collector.sample]) {
      const body = {
        runId: "collector-run",
        systemLog: "synthetic system event",
        metrics: [
          {
            ts: memory.sampled_at,
            cpu: 1,
            mem_used: 4096,
            mem_total: 16384,
            disk_used: 1024,
            disk_total: 8192,
            memory,
          },
        ],
        sandboxOperations: [
          {
            ts: memory.sampled_at,
            action_type: "cli",
            duration_ms: 10,
            success: true,
          },
        ],
      };
      expect(webhookTelemetryContract.send.body.parse(body)).toEqual(body);
      expect(memory.groups[1].peak).toBeNull();
      expect(memory.groups[1].status).toBe("partial");
      expect(memory.groups[2].local_events.oom).toBeNull();
    }
    for (const oomEvidence of [collector.sample, collector.cleanup]) {
      const body = { runId: "collector-run", oomEvidence };
      expect(webhookTelemetryContract.send.body.parse(body)).toEqual(body);
    }
    expect(collector.sample.incidents).toEqual(collector.cleanup.incidents);
  });

  it("keeps rejecting relative, malformed and cross-operation collector paths", () => {
    for (const path of [
      "vm0-exec/exec-281-10-3/workload",
      "//vm0-exec/exec-281-10-3/workload",
      "/sys/fs/cgroup/vm0-exec/exec-281-10-3/workload",
      "/tmp/vm0-exec/exec-281-10-3/workload",
      "/vm0-exec/exec-281-10-30/workload",
    ]) {
      const evidence = structuredClone(collector.sample);
      evidence.groups[0].cgroup = path;
      expect(oomEvidenceSchema.safeParse(evidence).success).toBe(false);
      evidence.groups = structuredClone(collector.sample.groups);
      for (const incident of evidence.incidents) {
        incident.groups[0].cgroup = path;
      }
      expect(oomEvidenceSchema.safeParse(evidence).success).toBe(false);
    }
  });

  it("preserves the Rust fixture and accepts old senders without evidence", () => {
    expect(oomEvidenceSchema.parse(fixture)).toEqual(fixture);
    expect(
      webhookTelemetryContract.send.body.parse({
        runId: "old-run",
        metrics: [],
      }),
    ).toEqual({ runId: "old-run", metrics: [] });
    expect(
      webhookTelemetryContract.send.responses[200].parse({
        success: true,
        id: "old-run",
      }),
    ).toEqual({ success: true, id: "old-run" });
  });

  it("rejects unrelated cgroups, old kernel events, excessive records and sensitive fields", () => {
    const evidence = oomEvidenceSchema.parse(fixture);
    for (const invalid of [
      { ...evidence, prompt: "private" },
      {
        ...evidence,
        incidents: Array.from({ length: 5 }, () => {
          return evidence.incidents[0];
        }),
      },
      {
        ...evidence,
        incidents: evidence.incidents.map((incident) => {
          return {
            ...incident,
            kernel_events: Array.from({ length: 5 }, () => {
              return incident.kernel_events[0];
            }),
          };
        }),
      },
      {
        ...evidence,
        incidents: evidence.incidents.map((incident) => {
          return {
            ...incident,
            kernel_events: incident.kernel_events.map((event) => {
              return { ...event, boottime_us: 999 };
            }),
          };
        }),
      },
      {
        ...evidence,
        incidents: evidence.incidents.map((incident) => {
          return {
            ...incident,
            kernel_events: incident.kernel_events.map((event) => {
              return {
                ...event,
                task_cgroup: "/vm0-exec/exec-2-3-4/workload/runtime",
              };
            }),
          };
        }),
      },
    ]) {
      expect(oomEvidenceSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
