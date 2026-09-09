import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

describe("OOM evidence wire compatibility", () => {
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
