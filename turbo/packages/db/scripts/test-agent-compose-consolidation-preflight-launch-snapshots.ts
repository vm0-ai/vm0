import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeComposeVersionId } from "../../../apps/api/src/signals/services/agent-compose-content";
import {
  LAUNCH_SNAPSHOT_DISPOSITIONS,
  LAUNCH_SNAPSHOT_REASONS,
  classifyLaunchSnapshotRecoverability,
  type LaunchSnapshotCheckpointInventoryRow,
  type LaunchSnapshotConversationInventoryRow,
  type LaunchSnapshotDisposition,
  type LaunchSnapshotRunInventoryRow,
  type LaunchSnapshotVersionInventoryRow,
} from "./agent-compose-consolidation-preflight-launch-snapshots";

const observedReasons = new Set<string>();

function agentContent(
  args: {
    readonly framework?: unknown;
    readonly profile?: unknown;
    readonly profilePresent?: boolean;
    readonly name?: string;
  } = {},
): Record<string, unknown> {
  const name = args.name ?? "agent";
  return {
    version: "1",
    agents: {
      [name]: {
        framework: args.framework ?? "claude-code",
        ...(args.profilePresent ? { experimental_profile: args.profile } : {}),
      },
    },
  };
}

function version(
  content: Record<string, unknown>,
): LaunchSnapshotVersionInventoryRow {
  return { id: computeComposeVersionId(content), content };
}

function run(
  id: string,
  versionId: string | null,
  overrides: Partial<LaunchSnapshotRunInventoryRow> = {},
): LaunchSnapshotRunInventoryRow {
  return {
    id,
    versionId,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    launchSnapshot: null,
    modelProvider: "anthropic-api-key",
    selectedModel: null,
    triggerSource: "slack",
    chatThreadPresent: false,
    metadataShape: "product",
    ...overrides,
  };
}

function checkpoint(
  runId: string,
  snapshot: unknown,
): LaunchSnapshotCheckpointInventoryRow {
  return { runId, snapshot };
}

function conversation(
  runId: string,
  framework: string,
): LaunchSnapshotConversationInventoryRow {
  return { runId, framework };
}

function classify(args: {
  readonly runs: readonly LaunchSnapshotRunInventoryRow[];
  readonly versions?: readonly LaunchSnapshotVersionInventoryRow[];
  readonly checkpoints?: readonly LaunchSnapshotCheckpointInventoryRow[];
  readonly conversations?: readonly LaunchSnapshotConversationInventoryRow[];
}) {
  const result = classifyLaunchSnapshotRecoverability({
    runs: args.runs,
    versions: args.versions ?? [],
    checkpoints: args.checkpoints ?? [],
    conversations: args.conversations ?? [],
  });
  for (const [reason, metric] of Object.entries(result.output.reasons)) {
    if (metric.count > 0) observedReasons.add(reason);
  }
  return result;
}

function assertAllClosuresExact(
  result: ReturnType<typeof classifyLaunchSnapshotRecoverability>,
): void {
  assert.equal(result.output.populationClosure.classification, "exact");
  assert.equal(
    result.output.dispositionPartitionClosure.classification,
    "exact",
  );
  assert.equal(
    result.output.dispositionDisjointnessClosure.classification,
    "exact",
  );
  assert.equal(result.output.dispositionUnionClosure.classification, "exact");
  assert.equal(result.output.reasonPartitionClosure.classification, "exact");
  assert.equal(result.output.reasonUnionClosure.classification, "exact");
  assert.equal(
    result.output.reasonCompatibilityClosure.classification,
    "exact",
  );
}

function assertSingleDisposition(
  result: ReturnType<typeof classifyLaunchSnapshotRecoverability>,
  expected: LaunchSnapshotDisposition,
): void {
  assert.equal(result.output.total, 1);
  for (const disposition of LAUNCH_SNAPSHOT_DISPOSITIONS) {
    assert.equal(
      result.output.dispositions[disposition].count,
      disposition === expected ? 1 : 0,
    );
  }
  assertAllClosuresExact(result);
}

function testCompletePartitionAndStrictSnapshots(): void {
  const content = agentContent();
  const storedVersion = version(content);
  const result = classify({
    runs: [
      run("already", storedVersion.id, {
        launchSnapshot: {
          schemaVersion: 1,
          framework: "claude-code",
          runnerProfile: "vm0/default",
        },
      }),
      run("recoverable", storedVersion.id),
      run("unknown", null),
      run("conflict", storedVersion.id, {
        launchSnapshot: {
          schemaVersion: 1,
          framework: "claude-code",
          runnerProfile: "vm0/default",
          extra: true,
        },
      }),
    ],
    versions: [storedVersion],
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.output.dispositions).map(([key, metric]) => {
        return [key, metric.count];
      }),
    ),
    {
      already_valid: 1,
      exactly_recoverable: 1,
      historical_unknown: 1,
      integrity_conflict: 1,
    },
  );
  assertAllClosuresExact(result);
  assert.deepEqual(result.failureGates, ["launchSnapshots.integrity_conflict"]);

  for (const launchSnapshot of [
    null,
    [],
    "snapshot",
    { schemaVersion: 1, framework: "claude-code", runnerProfile: "" },
    { schemaVersion: 2, framework: "claude-code", runnerProfile: "profile" },
    { schemaVersion: 1, framework: "other", runnerProfile: "profile" },
  ]) {
    const invalid = classify({
      runs: [run("invalid-snapshot", storedVersion.id, { launchSnapshot })],
      versions: [storedVersion],
    });
    if (launchSnapshot === null) {
      assert.equal(invalid.output.dispositions.exactly_recoverable.count, 1);
    } else {
      assert.equal(invalid.output.dispositions.integrity_conflict.count, 1);
    }
  }
}

function testVersionAndCheckpointEvidence(): void {
  const content = agentContent({ profile: "vm0/small", profilePresent: true });
  const storedVersion = version(content);
  const matching = classify({
    runs: [
      run("run-reference", storedVersion.id),
      run("checkpoint-reference", null),
      run("matching-references", storedVersion.id),
      run("shared-reference", storedVersion.id),
    ],
    versions: [storedVersion],
    checkpoints: [
      checkpoint("checkpoint-reference", {
        agentComposeVersionId: storedVersion.id,
        vars: { SAFE: "value" },
        secretNames: ["SECRET"],
      }),
      checkpoint("matching-references", {
        agentComposeVersionId: storedVersion.id,
      }),
    ],
  });
  assert.equal(matching.output.dispositions.exactly_recoverable.count, 4);
  assert.equal(matching.output.reasons.run_version_reference_exact.count, 2);
  assert.equal(
    matching.output.reasons.checkpoint_version_reference_exact.count,
    1,
  );
  assert.equal(
    matching.output.reasons.run_checkpoint_version_reference_exact.count,
    1,
  );
  assertAllClosuresExact(matching);

  const otherContent = agentContent({ framework: "codex" });
  const otherVersion = version(otherContent);
  const conflicts = classify({
    runs: [
      run("reference-conflict", storedVersion.id),
      run("malformed-checkpoint", storedVersion.id),
      run("missing-run-version", "a".repeat(64)),
      run("missing-checkpoint-version", null),
    ],
    versions: [storedVersion, otherVersion],
    checkpoints: [
      checkpoint("reference-conflict", {
        agentComposeVersionId: otherVersion.id,
      }),
      checkpoint("malformed-checkpoint", {
        agentComposeVersionId: storedVersion.id,
        unexpected: true,
      }),
      checkpoint("missing-checkpoint-version", {
        agentComposeVersionId: "b".repeat(64),
      }),
    ],
  });
  assert.equal(conflicts.output.dispositions.integrity_conflict.count, 4);
  assert.equal(
    conflicts.output.reasons.run_checkpoint_version_conflict.count,
    1,
  );
  assert.equal(conflicts.output.reasons.checkpoint_snapshot_malformed.count, 1);
  assert.equal(conflicts.output.reasons.run_version_missing.count, 1);
  assert.equal(conflicts.output.reasons.checkpoint_version_missing.count, 1);

  const malformedVariants = [
    null,
    [],
    { agentComposeVersionId: "invalid" },
    { agentComposeVersionId: storedVersion.id, vars: { INVALID: 1 } },
    { agentComposeVersionId: storedVersion.id, secretNames: [1] },
  ];
  for (const [index, snapshot] of malformedVariants.entries()) {
    const malformed = classify({
      runs: [run(`malformed-${index}`, storedVersion.id)],
      versions: [storedVersion],
      checkpoints: [checkpoint(`malformed-${index}`, snapshot)],
    });
    assert.equal(malformed.output.dispositions.integrity_conflict.count, 1);
  }

  const mismatchedHash = classify({
    runs: [run("hash-conflict", "c".repeat(64))],
    versions: [{ id: "c".repeat(64), content }],
  });
  assert.equal(mismatchedHash.output.dispositions.integrity_conflict.count, 1);
  assert.equal(
    mismatchedHash.output.reasons.legacy_content_hash_conflict.count,
    1,
  );
}

function testProviderAndProductionRolloutHistory(): void {
  const claudeContent = agentContent({ framework: "claude-code" });
  const claudeVersion = version(claudeContent);
  const codexContent = agentContent({ framework: "codex" });
  const codexVersion = version(codexContent);
  const result = classify({
    runs: [
      run("before-provider-rollout", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:14:32.999Z"),
        modelProvider: "openai-api-key",
      }),
      run("provider-rollout-transition", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:00.000Z"),
        modelProvider: "openai-api-key",
      }),
      run("provider-rollout-same-framework", codexVersion.id, {
        createdAt: new Date("2026-05-03T04:15:00.000Z"),
        modelProvider: "openai-api-key",
      }),
      run("after-provider-rollout", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:49.001Z"),
        modelProvider: "openai-api-key",
      }),
      run("claude-provider", codexVersion.id, {
        modelProvider: "anthropic-api-key",
      }),
      run("vm0-codex", claudeVersion.id, {
        modelProvider: "vm0",
        selectedModel: "gpt-5.5",
      }),
      run("vm0-missing", claudeVersion.id, {
        modelProvider: "vm0",
      }),
      run("vm0-retired", claudeVersion.id, {
        modelProvider: "vm0",
        selectedModel: "gpt-5.4",
      }),
      run("vm0-unknown", claudeVersion.id, {
        modelProvider: "vm0",
        selectedModel: "future-model",
      }),
      run("provider-retired", claudeVersion.id, {
        modelProvider: "moonshot-api-key",
      }),
      run("provider-unknown", claudeVersion.id, {
        modelProvider: "future-provider",
      }),
    ],
    versions: [claudeVersion, codexVersion],
  });
  assert.equal(result.output.dispositions.exactly_recoverable.count, 5);
  assert.equal(result.output.dispositions.historical_unknown.count, 6);
  assert.equal(
    result.output.reasons.framework_provider_precedence_inactive.count,
    1,
  );
  assert.equal(
    result.output.reasons.framework_provider_rollout_transition.count,
    1,
  );
  assert.equal(result.output.reasons.framework_provider_exact.count, 5);
  assert.equal(result.output.reasons.framework_vm0_model_exact.count, 1);
  assert.equal(result.output.reasons.framework_vm0_model_missing.count, 1);
  assert.equal(result.output.reasons.framework_vm0_model_retired.count, 1);
  assert.equal(result.output.reasons.framework_vm0_model_unknown.count, 1);
  assert.equal(result.output.reasons.framework_provider_retired.count, 1);
  assert.equal(result.output.reasons.framework_provider_unknown.count, 1);

  const flashHistory = classify({
    runs: [
      run("flash-before", claudeVersion.id, {
        createdAt: new Date("2026-07-31T12:06:01.999Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-flash",
      }),
      run("flash-transition", claudeVersion.id, {
        createdAt: new Date("2026-07-31T12:07:00.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-flash",
      }),
      run("flash-transition-start", claudeVersion.id, {
        createdAt: new Date("2026-07-31T12:06:02.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-flash",
      }),
      run("flash-transition-end", claudeVersion.id, {
        createdAt: new Date("2026-07-31T12:08:52.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-flash",
      }),
      run("flash-after", claudeVersion.id, {
        createdAt: new Date("2026-07-31T12:08:52.001Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-flash",
      }),
      run("pro-before-retirement", claudeVersion.id, {
        createdAt: new Date("2026-08-04T15:05:49.999Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
      }),
      run("pro-retirement-start", claudeVersion.id, {
        createdAt: new Date("2026-08-04T15:05:50.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
      }),
      run("pro-retirement-end", claudeVersion.id, {
        createdAt: new Date("2026-08-04T15:07:21.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
      }),
      run("pro-retired", claudeVersion.id, {
        createdAt: new Date("2026-08-10T00:00:00.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
      }),
      run("pro-reintroduction", claudeVersion.id, {
        createdAt: new Date("2026-08-12T18:51:00.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
      }),
      run("pro-after", claudeVersion.id, {
        createdAt: new Date("2026-08-12T18:52:37.001Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
      }),
    ],
    versions: [claudeVersion],
  });
  assert.equal(flashHistory.output.dispositions.exactly_recoverable.count, 4);
  assert.equal(flashHistory.output.dispositions.historical_unknown.count, 7);
}

function testExactProductionBoundaryEdges(): void {
  const claudeContent = agentContent({ framework: "claude-code" });
  const claudeVersion = version(claudeContent);
  const providerCases = [
    {
      row: run("provider-before", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:14:32.999Z"),
        modelProvider: "openai-api-key",
      }),
      disposition: "exactly_recoverable",
    },
    {
      row: run("provider-start", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:14:33.000Z"),
        modelProvider: "openai-api-key",
      }),
      disposition: "historical_unknown",
    },
    {
      row: run("provider-end", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:49.000Z"),
        modelProvider: "openai-api-key",
      }),
      disposition: "historical_unknown",
    },
    {
      row: run("provider-after", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:49.001Z"),
        modelProvider: "openai-api-key",
      }),
      disposition: "exactly_recoverable",
    },
  ] as const satisfies readonly {
    readonly row: LaunchSnapshotRunInventoryRow;
    readonly disposition: LaunchSnapshotDisposition;
  }[];
  const providerBoundary = classify({
    runs: providerCases.map(({ row }) => {
      return row;
    }),
    versions: [claudeVersion],
  });
  assert.equal(
    providerBoundary.output.dispositions.exactly_recoverable.count,
    2,
  );
  assert.equal(
    providerBoundary.output.dispositions.historical_unknown.count,
    2,
  );
  assert.equal(
    providerBoundary.output.reasons.framework_provider_rollout_transition.count,
    2,
  );
  for (const providerCase of providerCases) {
    assertSingleDisposition(
      classify({ runs: [providerCase.row], versions: [claudeVersion] }),
      providerCase.disposition,
    );
  }

  const missingProviderCases = [
    {
      row: run("missing-provider-before", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:14:32.999Z"),
        modelProvider: null,
      }),
      conversation: undefined,
      disposition: "exactly_recoverable",
    },
    {
      row: run("missing-provider-start", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:14:33.000Z"),
        modelProvider: null,
      }),
      conversation: undefined,
      disposition: "historical_unknown",
    },
    {
      row: run("missing-provider-end", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:49.000Z"),
        modelProvider: null,
      }),
      conversation: undefined,
      disposition: "historical_unknown",
    },
    {
      row: run("missing-provider-after", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:49.001Z"),
        modelProvider: null,
      }),
      conversation: undefined,
      disposition: "historical_unknown",
    },
    {
      row: run("missing-provider-conversation", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:49.001Z"),
        modelProvider: null,
      }),
      conversation: conversation("missing-provider-conversation", "codex"),
      disposition: "exactly_recoverable",
    },
  ] as const satisfies readonly {
    readonly row: LaunchSnapshotRunInventoryRow;
    readonly conversation: LaunchSnapshotConversationInventoryRow | undefined;
    readonly disposition: LaunchSnapshotDisposition;
  }[];
  const missingProviderBoundary = classify({
    runs: missingProviderCases.map(({ row }) => {
      return row;
    }),
    versions: [claudeVersion],
    conversations: missingProviderCases.flatMap(({ conversation }) => {
      return conversation ? [conversation] : [];
    }),
  });
  assert.equal(
    missingProviderBoundary.output.dispositions.exactly_recoverable.count,
    2,
  );
  assert.equal(
    missingProviderBoundary.output.dispositions.historical_unknown.count,
    3,
  );
  assert.equal(
    missingProviderBoundary.output.reasons.framework_provider_missing.count,
    5,
  );
  assert.equal(
    missingProviderBoundary.output.reasons.conversation_framework_valid.count,
    1,
  );
  assertAllClosuresExact(missingProviderBoundary);
  for (const providerCase of missingProviderCases) {
    assertSingleDisposition(
      classify({
        runs: [providerCase.row],
        versions: [claudeVersion],
        conversations: providerCase.conversation
          ? [providerCase.conversation]
          : [],
      }),
      providerCase.disposition,
    );
  }

  const profileBoundary = classify({
    runs: [
      run("profile-before", claudeVersion.id, {
        createdAt: new Date("2026-03-18T08:41:13.330Z"),
      }),
      run("profile-at-boundary", claudeVersion.id, {
        createdAt: new Date("2026-03-18T08:41:13.331Z"),
      }),
    ],
    versions: [claudeVersion],
  });
  assert.equal(profileBoundary.output.dispositions.historical_unknown.count, 1);
  assert.equal(
    profileBoundary.output.dispositions.exactly_recoverable.count,
    1,
  );
  assert.deepEqual(profileBoundary.failureGates, [
    "launchSnapshots.history_boundary",
  ]);

  const codexContent = agentContent({ framework: "codex" });
  const codexVersion = version(codexContent);
  const flashRestrictionBoundary = classify({
    runs: [
      run("flash-restriction-before", codexVersion.id, {
        createdAt: new Date("2026-08-10T03:38:02.999Z"),
        modelProvider: "deepseek",
        selectedModel: "gpt-5.5",
        triggerSource: "web",
        chatThreadPresent: true,
      }),
      run("flash-restriction-start", codexVersion.id, {
        createdAt: new Date("2026-08-10T03:38:03.000Z"),
        modelProvider: "deepseek",
        selectedModel: "gpt-5.5",
        triggerSource: "web",
        chatThreadPresent: true,
      }),
      run("flash-restriction-end", codexVersion.id, {
        createdAt: new Date("2026-08-10T03:39:34.000Z"),
        modelProvider: "deepseek",
        selectedModel: "gpt-5.5",
        triggerSource: "web",
        chatThreadPresent: true,
      }),
      run("flash-restriction-after", codexVersion.id, {
        createdAt: new Date("2026-08-10T03:39:34.001Z"),
        modelProvider: "deepseek",
        selectedModel: "gpt-5.5",
        triggerSource: "web",
        chatThreadPresent: true,
      }),
    ],
    versions: [codexVersion],
  });
  assert.equal(
    flashRestrictionBoundary.output.dispositions.historical_unknown.count,
    3,
  );
  assert.equal(
    flashRestrictionBoundary.output.dispositions.exactly_recoverable.count,
    1,
  );
  assert.equal(
    flashRestrictionBoundary.output.reasons.framework_pi_state_unproven.count,
    3,
  );

  const proExpansionBoundary = classify({
    runs: [
      run("pro-expansion-before", codexVersion.id, {
        createdAt: new Date("2026-08-12T18:50:25.999Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
        triggerSource: "web",
        chatThreadPresent: true,
      }),
      run("pro-expansion-start", codexVersion.id, {
        createdAt: new Date("2026-08-12T18:50:26.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
        triggerSource: "web",
        chatThreadPresent: true,
      }),
      run("pro-expansion-end", codexVersion.id, {
        createdAt: new Date("2026-08-12T18:52:37.000Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
        triggerSource: "web",
        chatThreadPresent: true,
      }),
      run("pro-expansion-after", codexVersion.id, {
        createdAt: new Date("2026-08-12T18:52:37.001Z"),
        modelProvider: "vm0",
        selectedModel: "deepseek-v4-pro",
        triggerSource: "web",
        chatThreadPresent: true,
      }),
    ],
    versions: [codexVersion],
  });
  assert.equal(
    proExpansionBoundary.output.dispositions.historical_unknown.count,
    4,
  );
  assert.equal(
    proExpansionBoundary.output.reasons.framework_vm0_model_retired.count,
    1,
  );
  assert.equal(
    proExpansionBoundary.output.reasons.framework_pi_state_unproven.count,
    3,
  );
}

function testPiAndConversationEvidence(): void {
  const codexContent = agentContent({ framework: "codex" });
  const codexVersion = version(codexContent);
  const commonPi = {
    modelProvider: "deepseek",
    selectedModel: "deepseek-v4-flash",
    triggerSource: "web",
    chatThreadPresent: true,
  } as const;
  const result = classify({
    runs: [
      run("before-pi", codexVersion.id, {
        ...commonPi,
        createdAt: new Date("2026-08-07T06:11:48.999Z"),
      }),
      run("initial-pi-transition", codexVersion.id, {
        ...commonPi,
        createdAt: new Date("2026-08-07T06:11:49.000Z"),
      }),
      run("callback-removal-transition", codexVersion.id, {
        ...commonPi,
        createdAt: new Date("2026-08-07T16:11:30.000Z"),
      }),
      run("flash-restriction-transition-other-model", codexVersion.id, {
        ...commonPi,
        selectedModel: "gpt-5.5",
        createdAt: new Date("2026-08-10T03:39:00.000Z"),
      }),
      run("after-flash-restriction-other-model", codexVersion.id, {
        ...commonPi,
        selectedModel: "gpt-5.5",
        createdAt: new Date("2026-08-10T03:39:34.001Z"),
      }),
      run("flash-eligible", codexVersion.id, {
        ...commonPi,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
      }),
      run("sandbox-transition", codexVersion.id, {
        ...commonPi,
        createdAt: new Date("2026-08-12T16:43:00.000Z"),
      }),
      run("pi-conversation", codexVersion.id, {
        ...commonPi,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
      }),
      run("pi-ineligible", codexVersion.id, {
        ...commonPi,
        chatThreadPresent: false,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
      }),
      run("pro-transition", codexVersion.id, {
        ...commonPi,
        selectedModel: "deepseek-v4-pro",
        createdAt: new Date("2026-08-12T18:51:00.000Z"),
      }),
      run("conversation-agreement", codexVersion.id, {
        modelProvider: "openai-api-key",
      }),
      run("conversation-conflict", codexVersion.id, {
        modelProvider: "openai-api-key",
      }),
      run("conversation-invalid", codexVersion.id, {
        modelProvider: "openai-api-key",
      }),
      run("conversation-proves-unknown-provider", codexVersion.id, {
        modelProvider: "future-provider",
      }),
    ],
    versions: [codexVersion],
    conversations: [
      conversation("pi-conversation", "pi"),
      conversation("pro-transition", "pi"),
      conversation("conversation-agreement", "codex"),
      conversation("conversation-conflict", "claude-code"),
      conversation("conversation-invalid", "future-framework"),
      conversation("conversation-proves-unknown-provider", "codex"),
    ],
  });
  assert.equal(result.output.dispositions.exactly_recoverable.count, 7);
  assert.equal(result.output.dispositions.historical_unknown.count, 5);
  assert.equal(result.output.dispositions.integrity_conflict.count, 2);
  assert.equal(result.output.reasons.framework_pi_state_unproven.count, 5);
  assert.equal(result.output.reasons.conversation_framework_valid.count, 5);
  assert.equal(result.output.reasons.conversation_framework_missing.count, 8);
  assert.equal(result.output.reasons.conversation_framework_conflict.count, 1);
  assert.equal(result.output.reasons.conversation_framework_invalid.count, 1);
}

function testPiEligibilityTriState(): void {
  const codexContent = agentContent({ framework: "codex" });
  const codexVersion = version(codexContent);
  const piWindow = new Date("2026-08-11T00:00:00.000Z");
  const common = {
    createdAt: piWindow,
    modelProvider: "deepseek",
    selectedModel: "deepseek-v4-flash",
    triggerSource: "web",
    chatThreadPresent: true,
  } as const;
  const cases = [
    {
      row: run("provider-missing-conversation", codexVersion.id, {
        ...common,
        modelProvider: null,
      }),
      conversation: conversation("provider-missing-conversation", "pi"),
      disposition: "exactly_recoverable",
    },
    {
      row: run("provider-missing-no-conversation", codexVersion.id, {
        ...common,
        modelProvider: null,
      }),
      conversation: undefined,
      disposition: "historical_unknown",
    },
    {
      row: run("model-missing-conversation", codexVersion.id, {
        ...common,
        selectedModel: null,
      }),
      conversation: conversation("model-missing-conversation", "pi"),
      disposition: "exactly_recoverable",
    },
    {
      row: run("model-missing-no-conversation", codexVersion.id, {
        ...common,
        selectedModel: null,
      }),
      conversation: undefined,
      disposition: "historical_unknown",
    },
    {
      row: run("model-unknown-conversation", codexVersion.id, {
        ...common,
        selectedModel: "future-model",
      }),
      conversation: conversation("model-unknown-conversation", "pi"),
      disposition: "exactly_recoverable",
    },
    {
      row: run("model-unknown-no-conversation", codexVersion.id, {
        ...common,
        selectedModel: "future-model",
      }),
      conversation: undefined,
      disposition: "historical_unknown",
    },
    {
      row: run("known-non-pi-model-conversation", codexVersion.id, {
        ...common,
        selectedModel: "gpt-5.5",
      }),
      conversation: conversation("known-non-pi-model-conversation", "pi"),
      disposition: "integrity_conflict",
    },
    {
      row: run("known-non-pi-model-no-conversation", codexVersion.id, {
        ...common,
        selectedModel: "gpt-5.5",
      }),
      conversation: undefined,
      disposition: "exactly_recoverable",
    },
    {
      row: run("non-web-pi-conversation", codexVersion.id, {
        ...common,
        triggerSource: "slack",
      }),
      conversation: conversation("non-web-pi-conversation", "pi"),
      disposition: "integrity_conflict",
    },
    {
      row: run("no-chat-pi-conversation", codexVersion.id, {
        ...common,
        chatThreadPresent: false,
      }),
      conversation: conversation("no-chat-pi-conversation", "pi"),
      disposition: "integrity_conflict",
    },
    {
      row: run("claude-base-pi-conversation", codexVersion.id, {
        ...common,
        modelProvider: "anthropic-api-key",
      }),
      conversation: conversation("claude-base-pi-conversation", "pi"),
      disposition: "integrity_conflict",
    },
    {
      row: run("before-pi-conversation", codexVersion.id, {
        ...common,
        createdAt: new Date("2026-08-07T06:11:48.999Z"),
      }),
      conversation: conversation("before-pi-conversation", "pi"),
      disposition: "integrity_conflict",
    },
  ] as const satisfies readonly {
    readonly row: LaunchSnapshotRunInventoryRow;
    readonly conversation: LaunchSnapshotConversationInventoryRow | undefined;
    readonly disposition: LaunchSnapshotDisposition;
  }[];
  const result = classify({
    runs: cases.map(({ row }) => {
      return row;
    }),
    versions: [codexVersion],
    conversations: cases.flatMap(({ conversation }) => {
      return conversation ? [conversation] : [];
    }),
  });
  assert.equal(result.output.dispositions.exactly_recoverable.count, 4);
  assert.equal(result.output.dispositions.historical_unknown.count, 3);
  assert.equal(result.output.dispositions.integrity_conflict.count, 5);
  assert.equal(result.output.reasons.framework_provider_missing.count, 2);
  assert.equal(result.output.reasons.framework_pi_model_missing.count, 1);
  assert.equal(result.output.reasons.framework_pi_model_unknown.count, 1);
  assert.equal(result.output.reasons.conversation_framework_conflict.count, 5);
  assert.deepEqual(result.failureGates, ["launchSnapshots.integrity_conflict"]);
  assertAllClosuresExact(result);
  for (const piCase of cases) {
    assertSingleDisposition(
      classify({
        runs: [piCase.row],
        versions: [codexVersion],
        conversations: piCase.conversation ? [piCase.conversation] : [],
      }),
      piCase.disposition,
    );
  }
}

function testProfilesLegacyContentAndBoundary(): void {
  const explicitContent = agentContent({
    profile: "vm0/custom",
    profilePresent: true,
  });
  const explicitVersion = version(explicitContent);
  const invalidProfileContent = agentContent({
    profile: 1,
    profilePresent: true,
  });
  const invalidProfileVersion = version(invalidProfileContent);
  const defaultContent = agentContent();
  const defaultVersion = version(defaultContent);
  const unsupportedContent = { version: "1", future: true };
  const unsupportedVersion = version(unsupportedContent);
  const invalidFrameworkContent = agentContent({ framework: "future" });
  const invalidFrameworkVersion = version(invalidFrameworkContent);
  const multiAgentContent = {
    version: "1",
    agents: {
      first: { framework: "codex", experimental_profile: "vm0/first" },
      second: {
        framework: "claude-code",
        experimental_profile: "vm0/second",
      },
    },
  };
  const multiAgentVersion = version(multiAgentContent);
  const conflictingShapes = {
    version: "1",
    agent: { framework: "claude-code" },
    agents: { other: { framework: "codex" } },
  };
  const conflictingShapesVersion = version(conflictingShapes);
  const result = classify({
    runs: [
      run("explicit-profile", explicitVersion.id),
      run("invalid-profile", invalidProfileVersion.id),
      run("proven-default", defaultVersion.id),
      run("default-drift", defaultVersion.id, {
        launchSnapshot: {
          schemaVersion: 1,
          framework: "claude-code",
          runnerProfile: "vm0/drifted",
        },
      }),
      run("unproven-default", defaultVersion.id, {
        createdAt: new Date("2026-03-18T08:41:13.330Z"),
      }),
      run("unsupported-content", unsupportedVersion.id),
      run("invalid-content", invalidFrameworkVersion.id, {
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        modelProvider: null,
      }),
      run("multi-agent", multiAgentVersion.id, {
        modelProvider: "openai-api-key",
      }),
      run("conflicting-agent-shapes", conflictingShapesVersion.id),
    ],
    versions: [
      explicitVersion,
      invalidProfileVersion,
      defaultVersion,
      unsupportedVersion,
      invalidFrameworkVersion,
      multiAgentVersion,
      conflictingShapesVersion,
    ],
  });
  assert.equal(result.output.dispositions.exactly_recoverable.count, 3);
  assert.equal(result.output.dispositions.historical_unknown.count, 5);
  assert.equal(result.output.dispositions.integrity_conflict.count, 1);
  assert.equal(result.output.reasons.runner_profile_explicit_exact.count, 2);
  assert.equal(result.output.reasons.runner_profile_invalid.count, 1);
  assert.equal(result.output.reasons.runner_profile_default_exact.count, 3);
  assert.equal(result.output.reasons.runner_profile_default_unproven.count, 1);
  assert.equal(
    result.output.reasons.created_before_reviewed_history_boundary.count,
    1,
  );
  assert.equal(result.output.reasons.legacy_content_unsupported.count, 2);
  assert.equal(result.output.reasons.legacy_content_invalid.count, 1);
  assert.ok(result.failureGates.includes("launchSnapshots.history_boundary"));

  const matchingFirstAgent = classify({
    runs: [
      run("multi-agent-match", multiAgentVersion.id, {
        modelProvider: "openai-api-key",
        launchSnapshot: {
          schemaVersion: 1,
          framework: "codex",
          runnerProfile: "vm0/first",
        },
      }),
    ],
    versions: [multiAgentVersion],
  });
  assert.equal(matchingFirstAgent.output.dispositions.already_valid.count, 1);

  const conflictingSecondAgent = classify({
    runs: [
      run("multi-agent-conflict", multiAgentVersion.id, {
        modelProvider: "openai-api-key",
        launchSnapshot: {
          schemaVersion: 1,
          framework: "claude-code",
          runnerProfile: "vm0/second",
        },
      }),
    ],
    versions: [multiAgentVersion],
  });
  assert.equal(
    conflictingSecondAgent.output.dispositions.integrity_conflict.count,
    1,
  );

  const reverseContent = {
    version: "1",
    agents: {
      second: {
        framework: "claude-code",
        experimental_profile: "vm0/second",
      },
      first: { framework: "codex", experimental_profile: "vm0/first" },
    },
  };
  const reverseVersion = version(reverseContent);
  const matchingReversedFirstAgent = classify({
    runs: [
      run("multi-agent-reverse", reverseVersion.id, {
        launchSnapshot: {
          schemaVersion: 1,
          framework: "claude-code",
          runnerProfile: "vm0/second",
        },
      }),
    ],
    versions: [reverseVersion],
  });
  assert.equal(
    matchingReversedFirstAgent.output.dispositions.already_valid.count,
    1,
  );
  assert.deepEqual(
    classify({
      runs: [
        run("multi-agent", multiAgentVersion.id, {
          modelProvider: "openai-api-key",
        }),
      ],
      versions: [multiAgentVersion],
    }).output,
    classify({
      runs: [
        run("multi-agent", multiAgentVersion.id, {
          modelProvider: "openai-api-key",
        }),
      ],
      versions: [multiAgentVersion],
    }).output,
  );
}

function testShapeClosureRedactionAndDomainSeparation(): void {
  const content = agentContent({
    framework: "codex",
    profile: "private/profile",
    profilePresent: true,
  });
  const storedVersion = version(content);
  const result = classify({
    runs: [
      run("raw-run-id", storedVersion.id, {
        modelProvider: "openai-api-key",
        selectedModel: "private-model",
        createdAt: new Date("2026-06-01T12:34:56.789Z"),
      }),
    ],
    versions: [storedVersion],
  });
  const serialized = JSON.stringify(result.output);
  for (const forbidden of [
    "raw-run-id",
    storedVersion.id,
    "openai-api-key",
    "private-model",
    "private/profile",
    "2026-06-01",
  ]) {
    assert.ok(!serialized.includes(forbidden), `leaked ${forbidden}`);
  }
  for (const metric of [
    result.output.population,
    ...Object.values(result.output.dispositions),
    ...Object.values(result.output.reasons),
  ]) {
    assert.match(metric.digest, /^[0-9a-f]{64}$/u);
  }
  assert.notEqual(
    result.output.dispositions.exactly_recoverable.digest,
    result.output.reasons.complete_exact_evidence.digest,
  );

  const duplicatePopulation = classify({
    runs: [run("duplicate", null), run("duplicate", null)],
  });
  assert.equal(
    duplicatePopulation.output.populationClosure.classification,
    "drift",
  );
  assert.ok(
    duplicatePopulation.failureGates.includes("launchSnapshots.closure"),
  );

  const invalidShape = classify({
    runs: [
      run("invalid-shape", storedVersion.id, {
        createdAt: new Date(Number.NaN),
      }),
    ],
    versions: [storedVersion],
  });
  assert.equal(invalidShape.output.dispositions.integrity_conflict.count, 1);
  assert.equal(
    invalidShape.output.reasons.otherwise_unclassified_shape.count,
    1,
  );
}

function testNullableLifecycleMetadataHistory(): void {
  const content = agentContent();
  const storedVersion = version(content);
  // This models the complete accepted field shape of the observed
  // lifecycle-only population without encoding its moving production count.
  const prePiLifecycle = classify({
    runs: [
      run("pre-pi-lifecycle", storedVersion.id, {
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        launchSnapshot: null,
        modelProvider: null,
        selectedModel: null,
        triggerSource: null,
        chatThreadPresent: false,
        metadataShape: "lifecycle_only",
      }),
    ],
    versions: [storedVersion],
  });
  assert.equal(prePiLifecycle.output.dispositions.exactly_recoverable.count, 1);
  assert.equal(prePiLifecycle.output.dispositions.integrity_conflict.count, 0);
  assert.equal(prePiLifecycle.output.reasons.complete_exact_evidence.count, 1);
  assert.deepEqual(prePiLifecycle.failureGates, []);
  assertAllClosuresExact(prePiLifecycle);

  const triggerDependentLifecycle = classify({
    runs: [
      run("pi-window-lifecycle", storedVersion.id, {
        createdAt: new Date("2026-08-07T06:11:49.000Z"),
        launchSnapshot: null,
        modelProvider: null,
        selectedModel: null,
        triggerSource: null,
        chatThreadPresent: false,
        metadataShape: "lifecycle_only",
      }),
    ],
    versions: [storedVersion],
  });
  assert.equal(
    triggerDependentLifecycle.output.dispositions.historical_unknown.count,
    1,
  );
  assert.equal(
    triggerDependentLifecycle.output.reasons.framework_provider_missing.count,
    1,
  );
  assert.equal(
    triggerDependentLifecycle.output.reasons.complete_exact_evidence.count,
    0,
  );
  assert.deepEqual(triggerDependentLifecycle.failureGates, []);
  assertAllClosuresExact(triggerDependentLifecycle);

  const partialMetadata = classify({
    runs: [
      run("partial-metadata", storedVersion.id, {
        modelProvider: "vm0",
        triggerSource: null,
        metadataShape: "partial",
      }),
    ],
    versions: [storedVersion],
  });
  assert.equal(partialMetadata.output.dispositions.integrity_conflict.count, 1);
  assert.equal(
    partialMetadata.output.reasons.otherwise_unclassified_shape.count,
    1,
  );
  assert.deepEqual(partialMetadata.failureGates, [
    "launchSnapshots.integrity_conflict",
  ]);
  assertAllClosuresExact(partialMetadata);

  const reviewedTriggerSources = classify({
    runs: [
      run("historical-non-web-trigger", storedVersion.id, {
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
        triggerSource: "slack",
      }),
      run("agent-trigger", storedVersion.id, {
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
        triggerSource: "agent",
      }),
      run("web-trigger", storedVersion.id, {
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
        triggerSource: "web",
      }),
    ],
    versions: [storedVersion],
  });
  assert.equal(
    reviewedTriggerSources.output.dispositions.exactly_recoverable.count,
    3,
  );
  assert.equal(
    reviewedTriggerSources.output.reasons.trigger_source_unrecognized.count,
    0,
  );
  assertAllClosuresExact(reviewedTriggerSources);

  const retiredTemplateImportTrigger = classify({
    runs: [
      run("retired-template-import-trigger", storedVersion.id, {
        createdAt: new Date("2026-08-12T00:00:00.000Z"),
        triggerSource: "template-import",
      }),
    ],
    versions: [storedVersion],
  });
  assertSingleDisposition(retiredTemplateImportTrigger, "exactly_recoverable");
  assert.equal(
    retiredTemplateImportTrigger.output.reasons.trigger_source_unrecognized
      .count,
    0,
  );

  const unrecognizedTriggerSource = classify({
    runs: [
      run("unrecognized-trigger", storedVersion.id, {
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
        triggerSource: "future-trigger",
      }),
    ],
    versions: [storedVersion],
  });
  assert.equal(
    unrecognizedTriggerSource.output.dispositions.integrity_conflict.count,
    1,
  );
  assert.equal(
    unrecognizedTriggerSource.output.reasons.trigger_source_unrecognized.count,
    1,
  );
  assert.deepEqual(unrecognizedTriggerSource.failureGates, [
    "launchSnapshots.integrity_conflict",
  ]);
  assertAllClosuresExact(unrecognizedTriggerSource);
}

async function testClassifierHasNoCurrentAuthorityLookup(): Promise<void> {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(
    path.join(
      dirname,
      "agent-compose-consolidation-preflight-launch-snapshots.ts",
    ),
    "utf8",
  );
  for (const forbidden of [
    "MODEL_PROVIDER_TYPES",
    "FeatureSwitch",
    "DEFAULT_PROFILE",
    "agent_composes",
    "zero_agents",
    "head_version_id",
    "composeId",
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `current authority lookup: ${forbidden}`,
    );
  }
}

export async function validateLaunchSnapshotRecoverabilityStatic(): Promise<void> {
  testCompletePartitionAndStrictSnapshots();
  testVersionAndCheckpointEvidence();
  testProviderAndProductionRolloutHistory();
  testExactProductionBoundaryEdges();
  testPiAndConversationEvidence();
  testPiEligibilityTriState();
  testProfilesLegacyContentAndBoundary();
  testShapeClosureRedactionAndDomainSeparation();
  testNullableLifecycleMetadataHistory();
  await testClassifierHasNoCurrentAuthorityLookup();
  assert.deepEqual(
    [...observedReasons].sort(),
    [...LAUNCH_SNAPSHOT_REASONS].sort(),
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateLaunchSnapshotRecoverabilityStatic().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
