import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeComposeVersionId } from "../../../apps/api/src/signals/services/agent-compose-content";
import {
  LAUNCH_SNAPSHOT_REASONS,
  classifyLaunchSnapshotRecoverability,
  type LaunchSnapshotCheckpointInventoryRow,
  type LaunchSnapshotConversationInventoryRow,
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
    modelProvider: null,
    selectedModel: null,
    triggerSource: "api",
    chatThreadPresent: false,
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
  const providerBoundary = classify({
    runs: [
      run("provider-before", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:14:32.999Z"),
        modelProvider: "openai-api-key",
      }),
      run("provider-start", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:14:33.000Z"),
        modelProvider: "openai-api-key",
      }),
      run("provider-end", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:49.000Z"),
        modelProvider: "openai-api-key",
      }),
      run("provider-after", claudeVersion.id, {
        createdAt: new Date("2026-05-03T04:15:49.001Z"),
        modelProvider: "openai-api-key",
      }),
    ],
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
      run("invalid-content", invalidFrameworkVersion.id),
      run("multi-agent", multiAgentVersion.id),
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
      runs: [run("multi-agent", multiAgentVersion.id)],
      versions: [multiAgentVersion],
    }).output,
    classify({
      runs: [run("multi-agent", multiAgentVersion.id)],
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
  testProfilesLegacyContentAndBoundary();
  testShapeClosureRedactionAndDomainSeparation();
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
