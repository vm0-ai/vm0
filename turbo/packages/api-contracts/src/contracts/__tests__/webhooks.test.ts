import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT } from "../runners";
import {
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
  storageManifestFilesSchema,
} from "../storages";
import {
  ACTIVE_INPUT_DELIVERY_RECEIPT_MAX_IDS,
  webhookCheckpointsContract,
  webhookCompleteContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookTelemetryContract,
} from "../webhooks";

const storageId = "00000000-0000-4000-8000-000000000000";
const manifestHash = "a".repeat(64);

describe("agent checkpoint session history", () => {
  const runId = "00000000-0000-4000-8000-000000000000";
  const checkpointMetadata = {
    cliAgentType: "codex",
    cliAgentSessionId: "00000000-0000-4000-8000-000000000001",
  };
  const baseBody = { runId, ...checkpointMetadata };

  it("accepts exactly one uploaded hash or historyless disposition", () => {
    expect(
      webhookCheckpointsContract.create.body.safeParse({
        ...baseBody,
        cliAgentSessionHistoryHash: manifestHash,
      }).success,
    ).toBe(true);
    expect(
      webhookCompleteContract.complete.body.safeParse({
        runId,
        exitCode: 0,
        checkpoint: {
          ...checkpointMetadata,
          cliAgentSessionHistoryHash: manifestHash,
        },
      }).success,
    ).toBe(true);
    expect(
      webhookCheckpointsContract.create.body.safeParse({
        ...baseBody,
        cliAgentSessionHistoryDisposition: "discarded_oversized",
      }).success,
    ).toBe(true);
    expect(
      webhookCheckpointsContract.create.body.safeParse({
        ...baseBody,
        cliAgentSessionHistoryDisposition: "unavailable",
      }).success,
    ).toBe(true);
  });

  it("rejects missing, conflicting, and unknown history dispositions", () => {
    const invalidMetadata = [
      checkpointMetadata,
      {
        ...checkpointMetadata,
        cliAgentSessionHistoryHash: manifestHash,
        cliAgentSessionHistoryDisposition: "discarded_oversized",
      },
      {
        ...checkpointMetadata,
        cliAgentSessionHistoryDisposition: "unknown",
      },
    ];

    for (const checkpoint of invalidMetadata) {
      expect(
        webhookCheckpointsContract.create.body.safeParse({
          runId,
          ...checkpoint,
        }).success,
      ).toBe(false);
      expect(
        webhookCompleteContract.complete.body.safeParse({
          runId,
          exitCode: 0,
          checkpoint,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps the outer completion run ID authoritative", () => {
    expect(
      webhookCompleteContract.complete.body.safeParse({
        runId,
        exitCode: 0,
        checkpoint: {
          runId,
          ...checkpointMetadata,
          cliAgentSessionHistoryDisposition: "unavailable",
        },
      }).success,
    ).toBe(false);
  });
});

function manifestFile(path: string) {
  return { path, hash: manifestHash, size: 0 };
}

describe("storage webhook manifest limits", () => {
  it("accepts the exact file-count boundary and rejects one more file", () => {
    const exactFiles = Array.from(
      { length: STORAGE_MANIFEST_MAX_FILES },
      (_, index) => {
        return manifestFile(`f-${index}`);
      },
    );
    const overFiles = [...exactFiles, manifestFile("over-limit")];

    expect(storageManifestFilesSchema.safeParse(exactFiles).success).toBe(true);
    expect(
      webhookStoragesPrepareContract.prepare.body.safeParse({
        runId: "run-id",
        storageId,
        files: overFiles,
      }).success,
    ).toBe(false);
  });

  it("accepts the exact path-byte boundary and rejects one more byte", () => {
    const exactFiles = [
      manifestFile("é".repeat(STORAGE_MANIFEST_MAX_PATH_BYTES / 2)),
    ];
    const overFiles = [
      manifestFile(`${"é".repeat(STORAGE_MANIFEST_MAX_PATH_BYTES / 2)}a`),
    ];

    expect(storageManifestFilesSchema.safeParse(exactFiles).success).toBe(true);
    expect(
      webhookStoragesCommitContract.commit.body.safeParse({
        runId: "run-id",
        storageId,
        versionId: manifestHash,
        files: overFiles,
      }).success,
    ).toBe(false);
  });
});

describe("agent completion reuse outcomes", () => {
  const baseBody = {
    runId: "00000000-0000-4000-8000-000000000000",
    exitCode: 0,
  };

  it("accepts legacy sandbox-only completion payloads", () => {
    for (const sandboxReuseResult of ["reused", "noSessionId"] as const) {
      expect(
        webhookCompleteContract.complete.body.safeParse({
          ...baseBody,
          sandboxReuseResult,
        }).success,
      ).toBe(true);
    }
  });

  it("accepts coherent final sandbox and workspace outcomes", () => {
    const workspaceMisses = [
      "cacheMiss",
      "noReuseKey",
      "invalidWorkingDir",
      "lockBusy",
      "invalidMetadata",
      "diskPressure",
      "notConfigured",
      "sandboxPrepareFallback",
    ] as const;
    const coherentPairs = [
      ["reused", "sandboxReused"],
      ["noReuseKey", "reused"],
      ...workspaceMisses.map((workspaceResult) => {
        return ["poolMiss", workspaceResult] as const;
      }),
    ] as const;

    for (const [sandboxReuseResult, workspaceReuseResult] of coherentPairs) {
      expect(
        webhookCompleteContract.complete.body.safeParse({
          ...baseBody,
          sandboxReuseResult,
          workspaceReuseResult,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects missing, legacy, or contradictory sandbox context", () => {
    const incoherentBodies = [
      { workspaceReuseResult: "cacheMiss" },
      {
        sandboxReuseResult: "reused",
        workspaceReuseResult: "cacheMiss",
      },
      {
        sandboxReuseResult: "poolMiss",
        workspaceReuseResult: "sandboxReused",
      },
      {
        sandboxReuseResult: "noSessionId",
        workspaceReuseResult: "cacheMiss",
      },
    ] as const;

    for (const body of incoherentBodies) {
      expect(
        webhookCompleteContract.complete.body.safeParse({
          ...baseBody,
          ...body,
        }).success,
      ).toBe(false);
    }
  });
});

describe("agent completion active input receipts", () => {
  const baseBody = {
    runId: "00000000-0000-4000-8000-000000000000",
    exitCode: 0,
  };
  const deliveryId = "00000000-0000-4000-8000-000000000001";

  it("accepts optional unique canonical delivery IDs", () => {
    expect(
      webhookCompleteContract.complete.body.parse({
        ...baseBody,
        activeInputDeliveryIds: [deliveryId],
      }),
    ).toMatchObject({ activeInputDeliveryIds: [deliveryId] });
    expect(
      webhookCompleteContract.complete.body.safeParse(baseBody).success,
    ).toBe(true);
  });

  it("rejects duplicate, malformed, non-canonical, and oversized IDs", () => {
    const invalidLists = [
      [deliveryId, deliveryId],
      ["not-a-uuid"],
      ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
      Array.from(
        { length: ACTIVE_INPUT_DELIVERY_RECEIPT_MAX_IDS + 1 },
        (_, index) => {
          return `00000000-0000-4000-8000-${index
            .toString(16)
            .padStart(12, "0")}`;
        },
      ),
    ];

    for (const activeInputDeliveryIds of invalidLists) {
      expect(
        webhookCompleteContract.complete.body.safeParse({
          ...baseBody,
          activeInputDeliveryIds,
        }).success,
      ).toBe(false);
    }
  });
});

describe("agent completion failure reasons", () => {
  const baseBody = {
    runId: "00000000-0000-4000-8000-000000000000",
    exitCode: 1,
  };

  it("accepts an optional bounded snake-case failure reason", () => {
    expect(
      webhookCompleteContract.complete.body.parse({
        ...baseBody,
        failureReason: "provider_rate_limited",
      }),
    ).toMatchObject({ failureReason: "provider_rate_limited" });
    expect(
      webhookCompleteContract.complete.body.safeParse(baseBody).success,
    ).toBe(true);
  });

  it("rejects malformed and overlong failure reasons", () => {
    for (const failureReason of [
      "ProviderRateLimited",
      "provider-rate-limited",
      "_provider_rate_limited",
      "a".repeat(65),
    ]) {
      expect(
        webhookCompleteContract.complete.body.safeParse({
          ...baseBody,
          failureReason,
        }).success,
      ).toBe(false);
    }
  });
});

describe("webhook telemetry contract", () => {
  it("preserves metric payload compatibility across Guest and API rollout", () => {
    const runId = "00000000-0000-4000-8000-000000000000";
    const oldMetric = {
      ts: "2026-09-01T00:00:00.000Z",
      cpu: 91.25,
      mem_used: 1024,
      mem_total: 2048,
      disk_used: 4096,
      disk_total: 8192,
    };
    const fullMetric = {
      ...oldMetric,
      cpu_steal_percent: 12.5,
      scheduled_lag_ms: 17,
      control_cpu_usage_usec: 101,
      control_cpu_nr_throttled: 2,
      control_cpu_throttled_usec: 3,
      workload_cpu_usage_usec: 201,
      workload_cpu_nr_throttled: 4,
      workload_cpu_throttled_usec: 5,
    };
    const partialMetric = {
      ...oldMetric,
      scheduled_lag_ms: 29,
      workload_cpu_usage_usec: 301,
    };

    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        metrics: [oldMetric],
      }).metrics,
    ).toStrictEqual([oldMetric]);
    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        metrics: [fullMetric],
      }).metrics,
    ).toStrictEqual([fullMetric]);
    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        metrics: [partialMetric],
      }).metrics,
    ).toStrictEqual([partialMetric]);

    const legacyMetricSchema = z.object({
      ts: z.string(),
      cpu: z.number(),
      mem_used: z.number(),
      mem_total: z.number(),
      disk_used: z.number(),
      disk_total: z.number(),
    });
    expect(legacyMetricSchema.parse(fullMetric)).toStrictEqual(oldMetric);
    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        metrics: [{ ...fullMetric, future_scheduler_queue_depth: 7 }],
      }).metrics,
    ).toStrictEqual([fullMetric]);
  });

  it("accepts optional bounded canonical runner dimensions", () => {
    const runId = "00000000-0000-4000-8000-000000000000";
    const minimalPayload = webhookTelemetryContract.send.body.parse({ runId });
    expect(minimalPayload).not.toHaveProperty("runnerHostname");
    expect(minimalPayload).not.toHaveProperty("runnerVersion");

    expect(
      webhookTelemetryContract.send.body.parse({
        runId,
        runnerHostname: "prod-1.aws.vm3.ai",
        runnerVersion: "0.168.14",
      }),
    ).toMatchObject({
      runnerHostname: "prod-1.aws.vm3.ai",
      runnerVersion: "0.168.14",
    });

    for (const runnerHostname of ["", "x".repeat(256)]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId,
          runnerHostname,
        }).success,
      ).toBe(false);
    }
    for (const runnerVersion of ["", "x".repeat(129)]) {
      expect(
        webhookTelemetryContract.send.body.safeParse({
          runId,
          runnerVersion,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts bounded sandbox operation outcome dimensions", () => {
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "session_history_prune",
          duration_ms: 10,
          success: true,
          outcome: "ineligible",
          reason: "source_within_guard",
        },
      ],
    });

    expect(result.sandboxOperations?.[0]).toMatchObject({
      outcome: "ineligible",
      reason: "source_within_guard",
    });
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "session_history_prune",
            duration_ms: 10,
            success: true,
            outcome: "x".repeat(65),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts fresh delivery scan summary dimensions", () => {
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "storage_cache_fresh_delivery_scan_suffix",
          duration_ms: 0,
          success: true,
          outcome: "5_8",
          reason: "3_4",
        },
      ],
    });

    expect(result.sandboxOperations?.[0]).toMatchObject({
      action_type: "storage_cache_fresh_delivery_scan_suffix",
      outcome: "5_8",
      reason: "3_4",
    });
  });

  it("accepts bounded startup outcomes and keeps them optional", () => {
    const startupOutcomes = [
      ["sandbox", "reused"],
      ["workspace", "noReuseKey"],
      ["cold", "poolMiss"],
      ["cold", "profileMismatch"],
      ["cold", "deviceLimitMismatch"],
      ["cold", "unparkFailed"],
    ] as const;
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        ...startupOutcomes.map(([runnerStartupPath, sandboxReuseResult]) => {
          return {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "api_to_spawn",
            duration_ms: 10,
            success: true,
            runner_startup_path: runnerStartupPath,
            sandbox_reuse_result: sandboxReuseResult,
          };
        }),
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "sandbox_create",
          duration_ms: 5,
          success: true,
        },
      ],
    });

    expect(
      result.sandboxOperations?.slice(0, startupOutcomes.length).map((op) => {
        return [op.runner_startup_path, op.sandbox_reuse_result];
      }),
    ).toStrictEqual(startupOutcomes);
    expect(result.sandboxOperations?.at(-1)).not.toHaveProperty(
      "runner_startup_path",
    );
  });

  it("rejects unknown startup outcomes", () => {
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "api_to_spawn",
            duration_ms: 10,
            success: true,
            runner_startup_path: "warm",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded runner pre-spawn concurrency and keeps it optional", () => {
    const buckets = ["1", "2", "3_4", "5_8", "9_plus"] as const;
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        ...buckets.map((bucket) => {
          return {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_pre_spawn_concurrency_bucket: bucket,
          };
        }),
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "agent_execute",
          duration_ms: 20,
          success: true,
        },
      ],
    });

    expect(
      result.sandboxOperations?.slice(0, buckets.length).map((operation) => {
        return operation.runner_pre_spawn_concurrency_bucket;
      }),
    ).toStrictEqual(buckets);
    expect(result.sandboxOperations?.at(-1)).not.toHaveProperty(
      "runner_pre_spawn_concurrency_bucket",
    );
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_pre_spawn_concurrency_bucket: "10_plus",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded runner resource-budget occupancy and keeps it optional", () => {
    const utilizationBuckets = [
      "0_25",
      "26_50",
      "51_75",
      "76_100",
      "over_100",
    ] as const;
    const leaseCountBuckets = ["0", "1", "2", "3_4", "5_8", "9_plus"] as const;
    const result = webhookTelemetryContract.send.body.parse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        ...leaseCountBuckets.map((leaseCount, index) => {
          const utilization =
            utilizationBuckets[index % utilizationBuckets.length];
          return {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_resource_budget_vcpu_utilization_bucket: utilization,
            runner_resource_budget_memory_utilization_bucket: utilization,
            runner_resource_budget_lease_count_bucket: leaseCount,
          };
        }),
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "agent_execute",
          duration_ms: 20,
          success: true,
        },
      ],
    });

    expect(
      result.sandboxOperations
        ?.slice(0, leaseCountBuckets.length)
        .map((operation) => {
          return [
            operation.runner_resource_budget_vcpu_utilization_bucket,
            operation.runner_resource_budget_memory_utilization_bucket,
            operation.runner_resource_budget_lease_count_bucket,
          ];
        }),
    ).toStrictEqual(
      leaseCountBuckets.map((leaseCount, index) => {
        const utilization =
          utilizationBuckets[index % utilizationBuckets.length];
        return [utilization, utilization, leaseCount];
      }),
    );
    expect(result.sandboxOperations?.at(-1)).not.toHaveProperty(
      "runner_resource_budget_vcpu_utilization_bucket",
    );
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_resource_budget_vcpu_utilization_bucket: "101_plus",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      webhookTelemetryContract.send.body.safeParse({
        runId: "00000000-0000-4000-8000-000000000000",
        sandboxOperations: [
          {
            ts: "2026-01-15T10:00:00.000Z",
            action_type: "runner_claim_to_spawn",
            duration_ms: 10,
            success: true,
            runner_resource_budget_lease_count_bucket: "10_plus",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts known session history download sources", () => {
    const result = webhookTelemetryContract.send.body.safeParse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "session_history_download",
          duration_ms: 10,
          success: true,
          session_history_download_source:
            SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("drops unknown session history download source strings", () => {
    const result = webhookTelemetryContract.send.body.safeParse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "session_history_download",
          duration_ms: 10,
          success: true,
          session_history_download_source: "regional_edge_cache",
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected webhook telemetry body to parse");
    }
    expect(
      result.data.sandboxOperations?.[0]?.session_history_download_source,
    ).toBeUndefined();
  });

  it("rejects non-string session history download sources", () => {
    const result = webhookTelemetryContract.send.body.safeParse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "session_history_download",
          duration_ms: 10,
          success: true,
          session_history_download_source: 123,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
