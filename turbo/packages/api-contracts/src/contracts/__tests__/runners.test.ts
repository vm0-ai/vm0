import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  compatibleStoredExecutionContextSchema,
  elapsedSinceApiStartMs,
  executionContextSchema,
  heartbeatBodySchema,
  heldSessionStateSchema,
  jobSchema,
  NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX,
  RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX,
  RUNNER_POLL_EXCLUDED_RUN_IDS_MAX,
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  resumeSessionSchema,
  runnersBuiltinFirewallsResolveContract,
  runnersJobClaimContract,
  runnersNetworkPolicyRefreshContract,
  runnersPollContract,
  storageMountEntrySchema,
  storageManifestSchema,
  storedConnectorPermissionBaselineSchema,
  storedExecutionContextSchema,
  storedResumeSessionSchema,
} from "../runners";

function loadRunnerClaimResponseFixture(): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "fixtures/runner-claim-response.json"),
      "utf-8",
    ),
  );
}

function connectorPermissionBaselineFixture() {
  return {
    version: 1 as const,
    catalogIdentity: {
      sourceId: "connector-catalog",
      schemaVersion: 1,
      catalogVersion: "2026-07-28",
      catalogDigest: `sha256:${"a".repeat(64)}`,
      capabilityDigest: `sha256:${"b".repeat(64)}`,
    },
    validationAuthority: {
      backendVersion: "1.337.1",
      buildCommitSha: "c".repeat(40),
    },
    connectors: {
      slack: {
        permissionNames: ["conversations:read", "chat:write"],
        defaultPolicy: {
          permissionDefault: "allow" as const,
          permissionOverrides: {
            deny: ["chat:write"],
          },
          unknownPolicy: "deny" as const,
        },
      },
    },
  };
}

describe("runner claim response contract", () => {
  it("accepts the shared current response fixture", () => {
    const context = executionContextSchema.parse(
      loadRunnerClaimResponseFixture(),
    );

    expect(context).toMatchObject({
      runId: "00000000-0000-4000-8000-000000020985",
      agentComposeVersionId:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      modelUsageProvider: "fixture-model",
    });
    expect(context).not.toHaveProperty("experimentalProfile");
  });

  it("does not expose the API-only connector permission baseline", () => {
    const fixture = executionContextSchema.parse(
      loadRunnerClaimResponseFixture(),
    );
    const context = executionContextSchema.parse({
      ...fixture,
      connectorPermissionBaseline: connectorPermissionBaselineFixture(),
    });

    expect(context).not.toHaveProperty("connectorPermissionBaseline");
  });
});

describe("stored connector permission baseline contract", () => {
  const storedContext = {
    storageMounts: [],
    environment: null,
    secretValueEnvironmentKeys: null,
    resumeSession: null,
    encryptedSecrets: null,
    cliAgentType: "codex",
  };

  it("accepts compact versioned defaults", () => {
    expect(
      storedConnectorPermissionBaselineSchema.parse(
        connectorPermissionBaselineFixture(),
      ),
    ).toEqual(connectorPermissionBaselineFixture());
  });

  it("rejects unsupported, overlapping, and unknown permission metadata", () => {
    const baseline = connectorPermissionBaselineFixture();
    expect(
      storedConnectorPermissionBaselineSchema.safeParse({
        ...baseline,
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      storedConnectorPermissionBaselineSchema.safeParse({
        ...baseline,
        connectors: {
          slack: {
            ...baseline.connectors.slack,
            defaultPolicy: {
              ...baseline.connectors.slack.defaultPolicy,
              permissionOverrides: {
                allow: ["chat:write"],
                deny: ["chat:write"],
              },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      storedConnectorPermissionBaselineSchema.safeParse({
        ...baseline,
        connectors: {
          slack: {
            ...baseline.connectors.slack,
            defaultPolicy: {
              ...baseline.connectors.slack.defaultPolicy,
              permissionOverrides: {
                deny: ["files:write"],
              },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("isolates future metadata to the compatible persisted reader", () => {
    const futureBaseline = { version: 2, payload: "future" };
    const context = {
      ...storedContext,
      connectorPermissionBaseline: futureBaseline,
    };

    expect(storedExecutionContextSchema.safeParse(context).success).toBe(false);

    const parsed = compatibleStoredExecutionContextSchema.parse(context);

    expect(parsed.connectorPermissionBaseline).toEqual(futureBaseline);
    expect(
      storedConnectorPermissionBaselineSchema.safeParse(
        parsed.connectorPermissionBaseline,
      ).success,
    ).toBe(false);
  });

  it("allows a previous reader to ignore the new optional field", () => {
    const previousStoredExecutionContextSchema =
      storedExecutionContextSchema.omit({
        connectorPermissionBaseline: true,
      });
    const parsed = previousStoredExecutionContextSchema.parse({
      ...storedContext,
      connectorPermissionBaseline: connectorPermissionBaselineFixture(),
    });

    expect(parsed).not.toHaveProperty("connectorPermissionBaseline");
  });
});

describe("runner poll response contract", () => {
  const job = {
    runId: "22222222-2222-4222-8222-222222222222",
    prompt: "continue",
    appendSystemPrompt: null,
    agentComposeVersionId: null,
    vars: null,
  };

  it.each(["vm0/default", "vm0/large"])(
    "requires and preserves profile %s",
    (experimentalProfile) => {
      expect(jobSchema.parse({ ...job, experimentalProfile })).toMatchObject({
        experimentalProfile,
      });
    },
  );

  it("rejects a missing profile", () => {
    expect(jobSchema.safeParse(job).success).toBe(false);
  });
});

describe("runner storage manifest contract", () => {
  const storedContext = {
    storageMounts: [],
    environment: null,
    secretValueEnvironmentKeys: null,
    resumeSession: null,
    encryptedSecrets: null,
    cliAgentType: "codex",
  };

  it("keeps prepared readers compatible with omitted stored fields", () => {
    const preparedStoredExecutionContextSchema =
      storedExecutionContextSchema.extend({
        storageManifest: z.unknown().nullable().optional(),
      });

    expect(preparedStoredExecutionContextSchema.parse(storedContext)).toEqual(
      storedContext,
    );
    expect(storedExecutionContextSchema.parse(storedContext)).toEqual(
      storedContext,
    );
  });

  it("requires canonical mounts while ignoring previous stored fields", () => {
    expect(
      compatibleStoredExecutionContextSchema.parse({
        ...storedContext,
        storageManifest: null,
      }),
    ).toEqual(storedContext);
    expect(
      compatibleStoredExecutionContextSchema.parse({
        ...storedContext,
        storageManifest: {
          storages: [{ futureLegacyField: true }],
          artifacts: [],
        },
      }),
    ).toEqual(storedContext);
    expect(
      compatibleStoredExecutionContextSchema.safeParse({
        ...storedContext,
        storageMounts: undefined,
      }).success,
    ).toBe(false);
  });

  it("accepts canonical read-only and writeback mounts", () => {
    expect(
      storageMountEntrySchema.parse({
        name: "workspace",
        storageId: "storage-id-1",
        versionId: "version-1",
        mountPath: "/workspace",
        archiveUrl: "https://storage.example/workspace.tar.gz",
      }),
    ).toMatchObject({
      name: "workspace",
      storageId: "storage-id-1",
      versionId: "version-1",
      mountPath: "/workspace",
    });

    expect(
      storageMountEntrySchema.parse({
        name: "memory",
        storageId: "storage-id-2",
        versionId: "version-2",
        mountPath: "/memory",
        empty: true,
        writeback: true,
      }),
    ).toMatchObject({
      name: "memory",
      empty: true,
      writeback: true,
    });
  });

  it("rejects canonical mounts that cannot preserve current behavior", () => {
    const base = {
      name: "workspace",
      storageId: "storage-id-1",
      versionId: "version-1",
      mountPath: "/workspace",
    };

    expect(storageMountEntrySchema.safeParse(base).success).toBe(false);
    expect(
      storageMountEntrySchema.safeParse({
        ...base,
        archiveUrl: "https://storage.example/workspace.tar.gz",
        empty: true,
      }).success,
    ).toBe(false);
    expect(
      storageMountEntrySchema.safeParse({
        ...base,
        archiveUrl: "https://storage.example/workspace.tar.gz",
        missingRootPolicy: "fail",
      }).success,
    ).toBe(false);
    expect(
      storageMountEntrySchema.safeParse({
        ...base,
        archiveUrl: "https://storage.example/workspace.tar.gz",
        instructionsTargetFilename: "AGENTS.md",
        writeback: true,
      }).success,
    ).toBe(false);
  });

  it("accepts only the canonical wire representation", () => {
    const canonical = {
      storageMounts: [
        {
          name: "workspace",
          storageId: "storage-id-1",
          versionId: "version-1",
          mountPath: "/workspace",
          archiveUrl: "https://storage.example/workspace.tar.gz",
        },
      ],
    };
    const legacy = { storages: [], artifacts: [] };

    expect(storageManifestSchema.parse(canonical)).toEqual(canonical);
    expect(storageManifestSchema.safeParse(legacy).success).toBe(false);
    expect(storageManifestSchema.safeParse({}).success).toBe(false);
    expect(
      storageManifestSchema.parse({
        ...canonical,
        futureRunnerField: true,
      }),
    ).toEqual(canonical);
  });

  it("rejects duplicate canonical mount paths", () => {
    const mount = {
      name: "workspace",
      storageId: "storage-id-1",
      versionId: "version-1",
      mountPath: "/workspace",
      archiveUrl: "https://storage.example/workspace.tar.gz",
    };

    expect(
      storageManifestSchema.safeParse({
        storageMounts: [mount, { ...mount, name: "replacement" }],
      }).success,
    ).toBe(false);
  });
});

describe("runner resume session contract", () => {
  const historyHash =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const historyGenerationRunId = "11111111-1111-4111-8111-111111111111";

  it("accepts inline stored and claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      sessionHistory: '{"type":"init"}\n',
    };

    expect(storedResumeSessionSchema.safeParse(resumeSession).success).toBe(
      true,
    );
    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(true);
  });

  it("accepts hash-backed stored resume sessions without URLs", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: historyHash },
    };

    expect(storedResumeSessionSchema.parse(resumeSession)).toEqual(
      resumeSession,
    );
    expect(
      storedExecutionContextSchema.shape.resumeSession.safeParse(resumeSession)
        .success,
    ).toBe(true);
  });

  it("keeps generation metadata in stable discovery and reusable shapes", () => {
    const historyGenerationAffinityProtectedUntil = "2026-07-15T00:00:00.500Z";
    const storedResumeSession = {
      sessionId: "sess-123",
      historyGenerationRunId,
      historyRef: { kind: "blob" as const, hash: historyHash },
    };
    expect(storedResumeSessionSchema.parse(storedResumeSession)).toEqual(
      storedResumeSession,
    );

    const claimResumeSession = resumeSessionSchema.parse({
      ...storedResumeSession,
      historyRef: {
        ...storedResumeSession.historyRef,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        encoding: "identity",
        rawSize: 1024,
        encodedSize: 1024,
      },
    });
    expect(claimResumeSession).not.toHaveProperty("historyGenerationRunId");

    const job = jobSchema.parse({
      runId: "22222222-2222-4222-8222-222222222222",
      prompt: "continue",
      appendSystemPrompt: null,
      agentComposeVersionId: null,
      vars: null,
      experimentalProfile: "vm0/default",
      historyGenerationRunId,
      historyGenerationAffinityProtectedUntil,
      sessionAffinityResource: "reusableSandbox",
    });
    expect(job.historyGenerationRunId).toBe(historyGenerationRunId);
    expect(job.historyGenerationAffinityProtectedUntil).toBe(
      historyGenerationAffinityProtectedUntil,
    );
    expect(job.sessionAffinityResource).toBe("reusableSandbox");

    const heldSessionState = heldSessionStateSchema.parse({
      sessionId: "sess-123",
      lastCompletedAt: "2026-07-15T00:00:00.000Z",
      reusableSandbox: {
        profile: "vm0/default",
        historyGenerationRunId,
      },
      workspaceCaches: [
        {
          profile: "vm0/default",
          workspaceAffinityVersion: 1,
        },
        { profile: "vm0/large" },
      ],
    });
    expect(heldSessionState.reusableSandbox?.historyGenerationRunId).toBe(
      historyGenerationRunId,
    );
    expect(heldSessionState.workspaceCaches).toEqual([
      {
        profile: "vm0/default",
        workspaceAffinityVersion: 1,
      },
      { profile: "vm0/large" },
    ]);
  });

  it("keeps generation-affinity additions optional for legacy runners", () => {
    const job = jobSchema.parse({
      runId: "22222222-2222-4222-8222-222222222222",
      prompt: "continue",
      appendSystemPrompt: null,
      agentComposeVersionId: null,
      vars: null,
      experimentalProfile: "vm0/default",
      historyGenerationAffinityProtectedUntil: null,
    });
    expect(job.historyGenerationAffinityProtectedUntil).toBeNull();
    expect(job.sessionAffinityResource).toBeUndefined();

    const heldSessionState = heldSessionStateSchema.parse({
      sessionId: "sess-legacy",
      lastCompletedAt: "2026-07-15T00:00:00.000Z",
      reusableSandbox: { profile: "vm0/default" },
    });
    expect(heldSessionState.reusableSandbox).toEqual({
      profile: "vm0/default",
    });
    expect(heldSessionState.workspaceCaches).toBeUndefined();
  });

  it("accepts ordered heartbeat snapshots", () => {
    const heartbeat = {
      runnerId: "33333333-3333-4333-8333-333333333333",
      runnerName: "runner-contract-test",
      group: "vm0/test",
      snapshotGeneration: 1,
      snapshotSequence: 1,
      totalVcpu: 8,
      totalMemoryMb: 16_384,
      maxConcurrent: 4,
      allocatedVcpu: 0,
      allocatedMemoryMb: 0,
      runningCount: 0,
      admittableProfiles: ["vm0/default"],
      heldSessionStates: [],
      mode: "running",
    } as const;

    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        snapshotGeneration: 7,
        snapshotSequence: 42,
      }).success,
    ).toBe(true);
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        snapshotGeneration: Number.MAX_SAFE_INTEGER,
        snapshotSequence: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    for (const invalidOrder of [
      { snapshotGeneration: 0, snapshotSequence: 1 },
      { snapshotGeneration: -1, snapshotSequence: 1 },
      { snapshotGeneration: 1.5, snapshotSequence: 1 },
      { snapshotGeneration: 1, snapshotSequence: 0 },
      { snapshotGeneration: 1, snapshotSequence: -1 },
      { snapshotGeneration: 1, snapshotSequence: 1.5 },
    ]) {
      expect(
        heartbeatBodySchema.safeParse({
          ...heartbeat,
          ...invalidOrder,
        }).success,
      ).toBe(false);
    }
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        snapshotGeneration: Number.MAX_SAFE_INTEGER + 1,
        snapshotSequence: 42,
      }).success,
    ).toBe(false);
  });

  it("bounds profile-qualified workspace cache heartbeat state", () => {
    const heartbeat = {
      runnerId: "33333333-3333-4333-8333-333333333333",
      runnerName: "runner-contract-test",
      group: "vm0/test",
      snapshotGeneration: 1,
      snapshotSequence: 1,
      totalVcpu: 8,
      totalMemoryMb: 16_384,
      maxConcurrent: 4,
      allocatedVcpu: 0,
      allocatedMemoryMb: 0,
      runningCount: 0,
      admittableProfiles: ["vm0/default"],
      mode: "running",
    } as const;
    const workspaceCaches = Array.from({ length: 8 }, (_, index) => {
      return { profile: `vm0/profile-${index}` };
    });
    const heldSessionStates = Array.from({ length: 128 }, (_, index) => {
      return {
        sessionId: `sess-${index}`,
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        workspaceCaches,
      };
    });

    expect(
      heartbeatBodySchema.safeParse({ ...heartbeat, heldSessionStates })
        .success,
    ).toBe(true);
    expect(
      heartbeatBodySchema.safeParse({
        ...heartbeat,
        heldSessionStates: [
          ...heldSessionStates,
          {
            sessionId: "sess-over-global-cap",
            lastCompletedAt: "2026-07-15T00:00:00.000Z",
            workspaceCaches: [{ profile: "vm0/default" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      heldSessionStateSchema.safeParse({
        sessionId: "sess-over-parent-cap",
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        workspaceCaches: [
          ...workspaceCaches,
          { profile: "vm0/profile-over-cap" },
        ],
      }).success,
    ).toBe(false);
    expect(
      heldSessionStateSchema.safeParse({
        sessionId: "sess-invalid-capability",
        lastCompletedAt: "2026-07-15T00:00:00.000Z",
        workspaceCaches: [
          { profile: "vm0/default", workspaceAffinityVersion: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps stored identity refs tolerant and requires explicit claim metadata", () => {
    const storedResumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: historyHash },
    };
    const claimResumeSessionWithoutEncoding = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        rawSize: 1024,
        encodedSize: 1024,
      },
    };
    const claimResumeSession = {
      ...claimResumeSessionWithoutEncoding,
      historyRef: {
        ...claimResumeSessionWithoutEncoding.historyRef,
        encoding: "identity",
      },
    };

    expect(
      storedResumeSessionSchema.safeParse(storedResumeSession).success,
    ).toBe(true);
    expect(resumeSessionSchema.safeParse(storedResumeSession).success).toBe(
      false,
    );
    expect(
      resumeSessionSchema.safeParse(claimResumeSessionWithoutEncoding).success,
    ).toBe(false);
    expect(resumeSessionSchema.parse(claimResumeSession)).toEqual(
      claimResumeSession,
    );
    expect(
      executionContextSchema.shape.resumeSession.safeParse(claimResumeSession)
        .success,
    ).toBe(true);
  });

  it("rejects non-lowercase session history hashes", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: "A".repeat(64) },
    };

    expect(storedResumeSessionSchema.safeParse(resumeSession).success).toBe(
      false,
    );
    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("rejects oversized hash-backed claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        encoding: "identity",
        rawSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
        encodedSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("accepts gzip hash-backed claim resume sessions with explicit sizes", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.gz?sig=secret",
        encoding: "gzip",
        rawSize: 1024,
        encodedSize: 128,
        downloadSource:
          SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
      },
    };

    expect(resumeSessionSchema.parse(resumeSession)).toEqual(resumeSession);
  });

  it("rejects unknown hash-backed claim resume session download sources", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        encoding: "identity",
        rawSize: 1024,
        encodedSize: 1024,
        downloadSource: "regional_edge_cache",
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("accepts zstd hash-backed stored and claim resume sessions", () => {
    const storedResumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        encoding: "zstd",
      },
    };
    const claimResumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.zst?sig=secret",
        encoding: "zstd",
        rawSize: 1024,
        encodedSize: 96,
      },
    };

    expect(storedResumeSessionSchema.parse(storedResumeSession)).toEqual(
      storedResumeSession,
    );
    expect(resumeSessionSchema.parse(claimResumeSession)).toEqual(
      claimResumeSession,
    );
  });

  it("rejects malformed gzip claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.gz?sig=secret",
        encoding: "gzip",
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("rejects malformed zstd claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.zst?sig=secret",
        encoding: "zstd",
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });
});

describe("runner claim capability contract", () => {
  it("accepts unknown capabilities for forward compatibility", () => {
    const result = runnersJobClaimContract.claim.body.safeParse({
      capabilities: ["futureCapability"],
    });

    expect(result.success).toBe(true);
  });

  it("accepts optional direct candidate timing telemetry", () => {
    const result = runnersJobClaimContract.claim.body.safeParse({
      telemetry: {
        discoverySource: "ably",
        jobDiscoveredToClaimRequestMs: 123,
        localAdmissionToClaimRequestMs: 4,
        directCandidateNotificationToEnqueueMs: 1,
        directCandidateInboxWaitMs: 2,
        providerDiscoveryToMainLoopMs: 3,
        mainLoopToLocalAdmissionMs: 4,
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts and strips previous runner telemetry", () => {
    const body = runnersJobClaimContract.claim.body.parse({
      telemetry: {
        sessionAffinityResource: "workspaceCache",
        sessionAffinityLocalResource: "workspaceCache",
        localAdmissionResource: "fresh",
        sessionHistoryGenerationRelationship: "fresh",
      },
    });

    expect(body.telemetry).toEqual({});
  });

  it("discards malformed diagnostic telemetry without weakening capabilities", () => {
    const body = runnersJobClaimContract.claim.body.parse({
      telemetry: {
        pollReason: "future-reason",
        jobDiscoveredToClaimRequestMs: -1,
      },
    });

    expect(body.telemetry).toEqual({});
    expect(
      runnersJobClaimContract.claim.body.safeParse({
        capabilities: [123],
      }).success,
    ).toBe(false);
  });
});

describe("runner poll request contract", () => {
  const group = "vm0/test";
  const supportedProfiles = ["vm0/default"];
  const runId = "550e8400-e29b-41d4-a716-446655440000";

  it("accepts bounded optional run exclusions", () => {
    expect(
      runnersPollContract.poll.body.parse({
        group,
        supportedProfiles,
        excludedRunIds: [runId],
      }),
    ).toEqual({
      group,
      supportedProfiles,
      excludedRunIds: [runId],
    });

    expect(
      runnersPollContract.poll.body.safeParse({
        group,
        supportedProfiles,
        excludedRunIds: Array.from(
          { length: RUNNER_POLL_EXCLUDED_RUN_IDS_MAX + 1 },
          () => {
            return runId;
          },
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects malformed exclusions and behavior-bearing routing fields", () => {
    expect(
      runnersPollContract.poll.body.safeParse({
        group,
        supportedProfiles,
        excludedRunIds: ["not-a-run-id"],
      }).success,
    ).toBe(false);
    expect(
      runnersPollContract.poll.body.safeParse({
        group,
        supportedProfiles: [],
      }).success,
    ).toBe(false);
  });

  it("discards malformed diagnostic telemetry", () => {
    const body = runnersPollContract.poll.body.parse({
      group,
      supportedProfiles,
      telemetry: { pollReason: "future-reason" },
    });

    expect(body.telemetry).toEqual({});
  });
});

describe("runner network policy refresh contract", () => {
  const bodySchema = runnersNetworkPolicyRefreshContract.refresh.body;

  it("normalizes canonical connector slugs and ignores additional fields", () => {
    expect(
      bodySchema.parse({
        connectorSlugs: ["slack", "github", "slack"],
        additionalField: true,
      }),
    ).toEqual({ connectorSlugs: ["slack", "github"] });
  });

  it.each([
    ["missing canonical field", {}],
    ["empty canonical field", { connectorSlugs: [] }],
    ["invalid canonical slug", { connectorSlugs: ["invalid/slack"] }],
    [
      "oversized canonical field",
      {
        connectorSlugs: Array.from(
          { length: NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX + 1 },
          () => {
            return "slack";
          },
        ),
      },
    ],
  ])("rejects %s", (_, body) => {
    expect(bodySchema.safeParse(body).success).toBe(false);
  });
});

describe("runner builtin firewall resolve contract", () => {
  it("accepts omitted names for full catalog resolution", () => {
    const result =
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({});

    expect(result.success).toBe(true);
  });

  it("accepts connector and model-provider names", () => {
    const result =
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: ["github", "model-provider:openai-api-key"],
      });

    expect(result.success).toBe(true);
  });

  it("rejects malformed and oversized requests", () => {
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse(null)
        .success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse([]).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: ["ModelProvider:openai-api-key"],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: ["model-provider:"],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: [],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: null,
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: "github",
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: [""],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        name: ["github"],
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: ["github"],
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      runnersBuiltinFirewallsResolveContract.resolve.body.safeParse({
        names: Array.from(
          { length: RUNNER_BUILTIN_FIREWALL_RESOLVE_NAMES_MAX + 1 },
          (_, index) => {
            return `github-${index}`;
          },
        ),
      }).success,
    ).toBe(false);
  });
});

describe("runner firewall entry contract", () => {
  it("accepts compact builtin firewall entries", () => {
    const firewalls = [
      {
        kind: "builtin",
        name: "zendesk",
        baseUrlVars: { ZENDESK_SUBDOMAIN: "acme" },
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
  });

  it("accepts inline firewall entries", () => {
    const firewalls = [
      {
        kind: "inline",
        firewall: {
          name: "internal-api",
          apis: [
            {
              base: "https://api.internal.example.com",
              auth: { headers: { Authorization: "${{ secrets.TOKEN }}" } },
              permissions: [{ name: "read", rules: ["GET /items"] }],
            },
          ],
        },
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
  });

  it("rejects legacy expanded firewall entries in execution contexts", () => {
    const firewalls = [
      {
        name: "github",
        apis: [{ base: "https://api.github.com", auth: { headers: {} } }],
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
  });

  it("rejects unsupported execution firewall kinds", () => {
    const firewalls = [
      {
        kind: "unknown",
        name: "github",
        apis: [{ base: "https://api.github.com", auth: { headers: {} } }],
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
  });
});

describe("runner apiStartTime contract", () => {
  it("accepts Unix epoch millisecond integers", () => {
    const timestamp = 1_700_000_000_000;

    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(true);
  });

  it("rejects fractional timestamps", () => {
    const timestamp = 1_700_000_000_000.5;

    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(false);
  });

  it("rejects negative timestamps", () => {
    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(-1).success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(-1).success,
    ).toBe(false);
  });

  it("rejects seconds-shaped timestamps", () => {
    const timestamp = 1_700_000_000;

    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(false);
  });

  it("computes elapsed milliseconds for valid apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000_000, 1_700_000_001_250)).toBe(
      1_250,
    );
  });

  it("clamps future apiStartTime values to zero elapsed milliseconds", () => {
    expect(elapsedSinceApiStartMs(1_700_000_001_250, 1_700_000_000_000)).toBe(
      0,
    );
  });

  it("skips seconds-shaped apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000, 1_700_000_001_250)).toBe(
      undefined,
    );
  });

  it("skips fractional apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000_000.5, 1_700_000_001_250)).toBe(
      undefined,
    );
  });
});

describe("runner Claude tool list contracts", () => {
  it("keeps runner context schemas tolerant of legacy tool list values", () => {
    expect(
      storedExecutionContextSchema.shape.tools.safeParse(["Bash,Read"]).success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.tools.safeParse(["Bash,Read"]).success,
    ).toBe(true);
  });
});
