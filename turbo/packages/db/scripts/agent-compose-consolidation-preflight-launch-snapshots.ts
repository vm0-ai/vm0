import { computeComposeVersionId } from "../../../apps/api/src/signals/services/agent-compose-content";
import {
  fingerprintSortedSet,
  type SetFingerprint,
} from "./agent-compose-consolidation-preflight-fingerprint";

type HistoricalFramework = "claude-code" | "codex" | "pi";
type BaseHistoricalFramework = Exclude<HistoricalFramework, "pi">;

export const LAUNCH_SNAPSHOT_DISPOSITIONS = [
  "already_valid",
  "exactly_recoverable",
  "historical_unknown",
  "integrity_conflict",
] as const;

export type LaunchSnapshotDisposition =
  (typeof LAUNCH_SNAPSHOT_DISPOSITIONS)[number];

export const LAUNCH_SNAPSHOT_REASONS = [
  "complete_exact_evidence",
  "conversation_framework_conflict",
  "conversation_framework_invalid",
  "conversation_framework_missing",
  "conversation_framework_valid",
  "created_before_reviewed_history_boundary",
  "evidence_conflict",
  "existing_snapshot_invalid",
  "existing_snapshot_valid",
  "framework_evidence_conflict",
  "framework_legacy_exact",
  "framework_pi_model_missing",
  "framework_pi_model_unknown",
  "framework_pi_state_unproven",
  "framework_provider_exact",
  "framework_provider_missing",
  "framework_provider_precedence_inactive",
  "framework_provider_retired",
  "framework_provider_rollout_transition",
  "framework_provider_unknown",
  "framework_vm0_model_exact",
  "framework_vm0_model_missing",
  "framework_vm0_model_retired",
  "framework_vm0_model_unknown",
  "legacy_content_exact",
  "legacy_content_hash_conflict",
  "legacy_content_invalid",
  "legacy_content_unsupported",
  "legacy_first_agent_exact",
  "no_version_reference",
  "otherwise_unclassified_shape",
  "checkpoint_snapshot_malformed",
  "checkpoint_version_missing",
  "checkpoint_version_reference_exact",
  "run_checkpoint_version_conflict",
  "run_checkpoint_version_reference_exact",
  "run_version_missing",
  "run_version_reference_exact",
  "runner_profile_default_exact",
  "runner_profile_default_unproven",
  "runner_profile_explicit_exact",
  "runner_profile_invalid",
  "trigger_source_unrecognized",
] as const;

export type LaunchSnapshotReason = (typeof LAUNCH_SNAPSHOT_REASONS)[number];

const ALL_DISPOSITIONS: readonly LaunchSnapshotDisposition[] =
  LAUNCH_SNAPSHOT_DISPOSITIONS;
const CONFLICT_ONLY = ["integrity_conflict"] as const;
const VALID_OR_CONFLICT = ["already_valid", "integrity_conflict"] as const;
const VALID_OR_UNKNOWN = ["already_valid", "historical_unknown"] as const;
const NOT_RECOVERABLE = [
  "already_valid",
  "historical_unknown",
  "integrity_conflict",
] as const;

// Informational reasons may overlap, but every overlap must be compatible with
// the single disposition. This exhaustive table makes a newly added reason a
// compile-time error and turns an unexpected combination into closure drift.
const REASON_DISPOSITION_COMPATIBILITY = {
  complete_exact_evidence: ["exactly_recoverable"],
  conversation_framework_conflict: CONFLICT_ONLY,
  conversation_framework_invalid: CONFLICT_ONLY,
  conversation_framework_missing: ALL_DISPOSITIONS,
  conversation_framework_valid: ALL_DISPOSITIONS,
  created_before_reviewed_history_boundary: ALL_DISPOSITIONS,
  evidence_conflict: CONFLICT_ONLY,
  existing_snapshot_invalid: CONFLICT_ONLY,
  existing_snapshot_valid: VALID_OR_CONFLICT,
  framework_evidence_conflict: CONFLICT_ONLY,
  framework_legacy_exact: ALL_DISPOSITIONS,
  framework_pi_model_missing: VALID_OR_UNKNOWN,
  framework_pi_model_unknown: VALID_OR_UNKNOWN,
  framework_pi_state_unproven: VALID_OR_UNKNOWN,
  framework_provider_exact: ALL_DISPOSITIONS,
  framework_provider_missing: ALL_DISPOSITIONS,
  framework_provider_precedence_inactive: ALL_DISPOSITIONS,
  framework_provider_retired: ALL_DISPOSITIONS,
  framework_provider_rollout_transition: ALL_DISPOSITIONS,
  framework_provider_unknown: ALL_DISPOSITIONS,
  framework_vm0_model_exact: ALL_DISPOSITIONS,
  framework_vm0_model_missing: ALL_DISPOSITIONS,
  framework_vm0_model_retired: ALL_DISPOSITIONS,
  framework_vm0_model_unknown: ALL_DISPOSITIONS,
  legacy_content_exact: ALL_DISPOSITIONS,
  legacy_content_hash_conflict: CONFLICT_ONLY,
  legacy_content_invalid: NOT_RECOVERABLE,
  legacy_content_unsupported: NOT_RECOVERABLE,
  legacy_first_agent_exact: ALL_DISPOSITIONS,
  no_version_reference: NOT_RECOVERABLE,
  otherwise_unclassified_shape: CONFLICT_ONLY,
  checkpoint_snapshot_malformed: CONFLICT_ONLY,
  checkpoint_version_missing: CONFLICT_ONLY,
  checkpoint_version_reference_exact: ALL_DISPOSITIONS,
  run_checkpoint_version_conflict: CONFLICT_ONLY,
  run_checkpoint_version_reference_exact: ALL_DISPOSITIONS,
  run_version_missing: CONFLICT_ONLY,
  run_version_reference_exact: ALL_DISPOSITIONS,
  runner_profile_default_exact: ALL_DISPOSITIONS,
  runner_profile_default_unproven: NOT_RECOVERABLE,
  runner_profile_explicit_exact: ALL_DISPOSITIONS,
  runner_profile_invalid: NOT_RECOVERABLE,
  trigger_source_unrecognized: CONFLICT_ONLY,
} as const satisfies Readonly<
  Record<LaunchSnapshotReason, readonly LaunchSnapshotDisposition[]>
>;

export interface LaunchSnapshotRunInventoryRow {
  readonly id: string;
  readonly versionId: string | null;
  readonly createdAt: Date;
  readonly launchSnapshot: unknown;
  readonly modelProvider: string | null;
  readonly selectedModel: string | null;
  readonly triggerSource: string | null;
  readonly chatThreadPresent: boolean;
  readonly metadataShape: "lifecycle_only" | "product" | "partial";
}

export interface LaunchSnapshotVersionInventoryRow {
  readonly id: string;
  readonly content: unknown;
}

export interface LaunchSnapshotCheckpointInventoryRow {
  readonly runId: string;
  readonly snapshot: unknown;
}

export interface LaunchSnapshotConversationInventoryRow {
  readonly runId: string;
  readonly framework: string;
}

export interface ClosureComparison {
  readonly expected: SetFingerprint;
  readonly observed: SetFingerprint;
  readonly classification: "exact" | "drift";
}

const REVIEWED_RUN_LOWER_BOUND_MS = Date.parse("2026-03-18T08:41:13.331Z");
// The vm0/default profile constant and former Web persistence path shipped in
// web-v12.119.0. Web completed at 2026-03-17T05:49:22Z and Runner at
// 05:50:31Z, more than 26 hours before this reviewed live lower bound.

// 4448bb2b2167 first threaded the former Web path's computed framework into
// dispatch. The first carrying Web release was web-v12.330.3. GitHub Actions
// run 25269380137 promoted it from 04:14:33 through 04:15:49 UTC, so neither
// source-commit time nor any time inside the rolling deployment is authority.
const PROVIDER_PRECEDENCE_ROLLOUT_START_MS = Date.parse(
  "2026-05-03T04:14:33.000Z",
);
const PROVIDER_PRECEDENCE_ROLLOUT_END_MS = Date.parse(
  "2026-05-03T04:15:49.000Z",
);

// Pi history is intentionally independent from today's feature switch and
// model catalog. The transient-callback path first reached API production in
// api-v1.396.0; subsequent boundaries use the complete successful production
// promotion intervals supplied by the carrying releases. Before the Flash
// restriction finishes rolling out, every compatible provider remains
// potentially Pi because callback and feature state were not persisted.
const PI_TRANSIENT_ROLLOUT_START_MS = Date.parse("2026-08-07T06:11:49.000Z");
const PI_CALLBACK_REMOVAL_ROLLOUT_START_MS = Date.parse(
  "2026-08-07T16:10:54.000Z",
);
const PI_CALLBACK_REMOVAL_ROLLOUT_END_MS = Date.parse(
  "2026-08-07T16:12:19.000Z",
);
const PI_FLASH_ROLLOUT_START_MS = Date.parse("2026-08-10T03:38:03.000Z");
const PI_FLASH_ROLLOUT_END_MS = Date.parse("2026-08-10T03:39:34.000Z");
const PI_SANDBOX_ROLLOUT_START_MS = Date.parse("2026-08-12T16:42:28.000Z");
const PI_SANDBOX_ROLLOUT_END_MS = Date.parse("2026-08-12T16:44:33.000Z");
const PI_PRO_ROLLOUT_START_MS = Date.parse("2026-08-12T18:50:26.000Z");
const PI_PRO_ROLLOUT_END_MS = Date.parse("2026-08-12T18:52:37.000Z");

// c6ac8c8a49 changed the Flash label from Claude to Codex in api-v1.362.0;
// its API promotion ran 2026-07-31T12:06:02Z through 12:08:52Z. c19ea0fa2d
// retired the former Pro route in api-v1.373.1, promoted 2026-08-04T15:05:50Z
// through 15:07:21Z. Pro did not become Codex evidence again until the
// api-v1.440.0 expansion above finished. Every rollout overlap is unknown.
const FLASH_CODEX_ROLLOUT_START_MS = Date.parse("2026-07-31T12:06:02.000Z");
const FLASH_CODEX_ROLLOUT_END_MS = Date.parse("2026-07-31T12:08:52.000Z");
const PRO_RETIREMENT_ROLLOUT_START_MS = Date.parse("2026-08-04T15:05:50.000Z");
const PRO_RETIREMENT_ROLLOUT_END_MS = Date.parse("2026-08-04T15:07:21.000Z");
const PRO_CODEX_ROLLOUT_END_MS = PI_PRO_ROLLOUT_END_MS;

// These are reviewed historical facts, not imports from the live catalog.
// Each label either predates the reviewed Run interval or carries the commit
// time at which that exact persisted label acquired its unchanged framework.
const HISTORICAL_PROVIDER_RULES = {
  "anthropic-api-key": "claude-code",
  "aws-bedrock": "claude-code",
  "azure-foundry": "claude-code",
  "claude-code-oauth-token": "claude-code",
  "codex-oauth-token": "codex",
  deepseek: "codex",
  "openai-api-key": "codex",
  "openrouter-api-key": "claude-code",
  "openrouter-codex": "codex",
  "vercel-ai-gateway": "claude-code",
  "vercel-ai-gateway-codex": "codex",
} as const satisfies Record<string, BaseHistoricalFramework>;

const RETIRED_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "deepseek-api-key",
  "deepseek-codex",
  "minimax-api-key",
  "moonshot-api-key",
  "zai-api-key",
]);

// Model labels in this map have one reviewed framework meaning over every
// interval in which the exact label was launchable. Removed labels stay in the
// retired set below even when their former concrete provider is knowable.
const HISTORICAL_VM0_MODEL_RULES = {
  "claude-fable-5": "claude-code",
  "claude-opus-5": "claude-code",
  "claude-opus-4-8": "claude-code",
  "claude-sonnet-5": "claude-code",
  "claude-sonnet-4-6": "claude-code",
  "gpt-5.5": "codex",
  "gpt-5.6-luna": "codex",
  "gpt-5.6-sol": "codex",
  "gpt-5.6-terra": "codex",
} as const satisfies Record<string, BaseHistoricalFramework>;

const RETIRED_VM0_MODELS: ReadonlySet<string> = new Set([
  "MiniMax-M3",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "glm-5.1",
  "glm-5.2",
  "gpt-5.4",
  "gpt-5.4-mini",
  "hy3-preview",
  "kimi-k2.7-code",
  "kimi-k3",
  "mimo-v2.5",
  "vm0-auto",
  "vm0-model",
]);

const DEFAULT_RUNNER_PROFILE = "vm0/default";
const VERSION_ID_PATTERN = /^[0-9a-f]{64}$/u;
const WEB_CHAT_TRIGGER_SOURCES: ReadonlySet<string> = new Set(["agent", "web"]);
// Fixed union of triggerSourceSchema values reviewed from 55fd4bf4209f
// (the first agent_runs trigger column) through cd91f26cd599 (the last
// retirement in the live Run interval). Retired persisted values stay valid;
// this must not import the live contract or treat a future label as non-web.
const HISTORICAL_TRIGGER_SOURCES: ReadonlySet<string> = new Set([
  "agent",
  "agentphone",
  "automation",
  "automation-event",
  "automation-schedule",
  "cli",
  "email",
  "feishu",
  "github",
  "goal",
  "imessage",
  "phone",
  "schedule",
  "slack",
  "teams",
  "telegram",
  "test",
  "voice-chat",
  "web",
  "webhook",
  "workflow-event",
  "workflow-schedule",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBaseFramework(value: unknown): value is BaseHistoricalFramework {
  return value === "claude-code" || value === "codex";
}

function isFramework(value: unknown): value is HistoricalFramework {
  return isBaseFramework(value) || value === "pi";
}

function isValidProfile(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function strictLaunchSnapshot(value: unknown): {
  readonly framework: HistoricalFramework;
  readonly runnerProfile: string;
} | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "framework" ||
    keys[1] !== "runnerProfile" ||
    keys[2] !== "schemaVersion" ||
    value.schemaVersion !== 1 ||
    !isFramework(value.framework) ||
    !isValidProfile(value.runnerProfile)
  ) {
    return null;
  }
  return {
    framework: value.framework,
    runnerProfile: value.runnerProfile,
  };
}

type CheckpointReference =
  | { readonly classification: "absent" }
  | { readonly classification: "invalid" }
  | { readonly classification: "valid"; readonly versionId: string };

function checkpointReference(snapshot: unknown): CheckpointReference {
  if (!isRecord(snapshot)) return { classification: "invalid" };
  const allowedKeys = new Set(["agentComposeVersionId", "secretNames", "vars"]);
  if (
    Object.keys(snapshot).some((key) => {
      return !allowedKeys.has(key);
    })
  ) {
    return { classification: "invalid" };
  }
  if (
    "vars" in snapshot &&
    (!isRecord(snapshot.vars) ||
      Object.values(snapshot.vars).some((value) => {
        return typeof value !== "string";
      }))
  ) {
    return { classification: "invalid" };
  }
  if (
    "secretNames" in snapshot &&
    (!Array.isArray(snapshot.secretNames) ||
      snapshot.secretNames.some((value) => {
        return typeof value !== "string";
      }))
  ) {
    return { classification: "invalid" };
  }
  if (!("agentComposeVersionId" in snapshot)) {
    return { classification: "absent" };
  }
  if (
    typeof snapshot.agentComposeVersionId !== "string" ||
    !VERSION_ID_PATTERN.test(snapshot.agentComposeVersionId)
  ) {
    return { classification: "invalid" };
  }
  return {
    classification: "valid",
    versionId: snapshot.agentComposeVersionId,
  };
}

interface HistoricalAgent {
  readonly framework: unknown;
  readonly profilePresent: boolean;
  readonly profile: unknown;
}

type HistoricalContent =
  | { readonly classification: "invalid" }
  | { readonly classification: "unsupported" }
  | { readonly classification: "exact"; readonly agent: HistoricalAgent };

function historicalFirstAgent(content: unknown): HistoricalContent {
  if (!isRecord(content)) return { classification: "invalid" };
  const singularPresent = "agent" in content && Boolean(content.agent);
  const pluralPresent = "agents" in content && content.agents !== undefined;
  if (singularPresent && pluralPresent) {
    return { classification: "unsupported" };
  }

  let value: unknown;
  if (singularPresent) {
    value = content.agent;
  } else if (pluralPresent) {
    if (!isRecord(content.agents)) return { classification: "invalid" };
    const firstKey = Object.keys(content.agents)[0];
    if (!firstKey) return { classification: "unsupported" };
    value = content.agents[firstKey];
  } else {
    return { classification: "unsupported" };
  }

  if (!isRecord(value)) return { classification: "invalid" };
  return {
    classification: "exact",
    agent: {
      framework: value.framework,
      profilePresent: "experimental_profile" in value,
      profile: value.experimental_profile,
    },
  };
}

interface RunClassification {
  readonly disposition: LaunchSnapshotDisposition;
  readonly primaryReason: LaunchSnapshotReason;
  readonly reasons: ReadonlySet<LaunchSnapshotReason>;
}

interface ResolvedVersionEvidence {
  readonly content: unknown | undefined;
  readonly conflictReason: LaunchSnapshotReason | undefined;
  readonly unknownReason: LaunchSnapshotReason | undefined;
}

function addReason(
  reasons: Set<LaunchSnapshotReason>,
  reason: LaunchSnapshotReason,
): void {
  reasons.add(reason);
}

interface ReferenceEvidenceArgs {
  readonly run: LaunchSnapshotRunInventoryRow;
  readonly checkpoint: LaunchSnapshotCheckpointInventoryRow | undefined;
  readonly duplicateCheckpoint: boolean;
  readonly versions: ReadonlyMap<string, LaunchSnapshotVersionInventoryRow>;
  readonly duplicateVersionIds: ReadonlySet<string>;
  readonly reasons: Set<LaunchSnapshotReason>;
}

function referenceConflict(
  reason: LaunchSnapshotReason,
  reasons: Set<LaunchSnapshotReason>,
): ResolvedVersionEvidence {
  addReason(reasons, reason);
  return {
    content: undefined,
    conflictReason: reason,
    unknownReason: undefined,
  };
}

function referenceUnknown(
  reason: LaunchSnapshotReason,
  reasons: Set<LaunchSnapshotReason>,
  content?: unknown,
): ResolvedVersionEvidence {
  addReason(reasons, reason);
  return {
    content,
    conflictReason: undefined,
    unknownReason: reason,
  };
}

function referenceShapeConflict(
  args: ReferenceEvidenceArgs,
): ResolvedVersionEvidence | undefined {
  if (args.duplicateCheckpoint) {
    return referenceConflict("otherwise_unclassified_shape", args.reasons);
  }
  if (
    args.run.versionId !== null &&
    (typeof args.run.versionId !== "string" ||
      !VERSION_ID_PATTERN.test(args.run.versionId))
  ) {
    return referenceConflict("otherwise_unclassified_shape", args.reasons);
  }
  return undefined;
}

type ValidCheckpointReference = Exclude<
  CheckpointReference,
  { readonly classification: "invalid" }
>;

function resolveCheckpointReference(
  args: ReferenceEvidenceArgs,
):
  | { readonly checkpoint: ValidCheckpointReference }
  | { readonly terminal: ResolvedVersionEvidence } {
  const checkpoint = args.checkpoint
    ? checkpointReference(args.checkpoint.snapshot)
    : ({ classification: "absent" } as const);
  if (checkpoint.classification === "invalid") {
    return {
      terminal: referenceConflict(
        "checkpoint_snapshot_malformed",
        args.reasons,
      ),
    };
  }
  if (
    args.run.versionId !== null &&
    checkpoint.classification === "valid" &&
    args.run.versionId !== checkpoint.versionId
  ) {
    return {
      terminal: referenceConflict(
        "run_checkpoint_version_conflict",
        args.reasons,
      ),
    };
  }
  return { checkpoint };
}

function loadReferencedVersion(args: {
  readonly referenceArgs: ReferenceEvidenceArgs;
  readonly checkpoint: ValidCheckpointReference;
  readonly effectiveVersionId: string;
}): ResolvedVersionEvidence {
  const { referenceArgs, checkpoint, effectiveVersionId } = args;
  if (referenceArgs.duplicateVersionIds.has(effectiveVersionId)) {
    return referenceConflict(
      "otherwise_unclassified_shape",
      referenceArgs.reasons,
    );
  }

  const version = referenceArgs.versions.get(effectiveVersionId);
  if (!version) {
    if (referenceArgs.run.versionId !== null) {
      addReason(referenceArgs.reasons, "run_version_missing");
    }
    if (checkpoint.classification === "valid") {
      addReason(referenceArgs.reasons, "checkpoint_version_missing");
    }
    return {
      content: undefined,
      conflictReason:
        referenceArgs.run.versionId !== null
          ? "run_version_missing"
          : "checkpoint_version_missing",
      unknownReason: undefined,
    };
  }

  if (
    referenceArgs.run.versionId !== null &&
    checkpoint.classification === "valid"
  ) {
    addReason(referenceArgs.reasons, "run_checkpoint_version_reference_exact");
  } else if (referenceArgs.run.versionId !== null) {
    addReason(referenceArgs.reasons, "run_version_reference_exact");
  } else {
    addReason(referenceArgs.reasons, "checkpoint_version_reference_exact");
  }

  if (!isRecord(version.content)) {
    return referenceUnknown(
      "legacy_content_invalid",
      referenceArgs.reasons,
      version.content,
    );
  }
  let computedVersionId: string;
  try {
    computedVersionId = computeComposeVersionId(version.content);
  } catch {
    return referenceConflict(
      "otherwise_unclassified_shape",
      referenceArgs.reasons,
    );
  }
  if (computedVersionId !== effectiveVersionId) {
    addReason(referenceArgs.reasons, "legacy_content_hash_conflict");
    addReason(referenceArgs.reasons, "evidence_conflict");
    return {
      content: undefined,
      conflictReason: "legacy_content_hash_conflict",
      unknownReason: undefined,
    };
  }
  return {
    content: version.content,
    conflictReason: undefined,
    unknownReason: undefined,
  };
}

function classifyReferenceEvidence(
  args: ReferenceEvidenceArgs,
): ResolvedVersionEvidence {
  const shapeConflict = referenceShapeConflict(args);
  if (shapeConflict) return shapeConflict;

  const checkpointResolution = resolveCheckpointReference(args);
  if ("terminal" in checkpointResolution) {
    return checkpointResolution.terminal;
  }
  const { checkpoint } = checkpointResolution;
  const effectiveVersionId =
    args.run.versionId ??
    (checkpoint.classification === "valid" ? checkpoint.versionId : null);
  if (effectiveVersionId === null) {
    return referenceUnknown("no_version_reference", args.reasons);
  }
  return loadReferencedVersion({
    referenceArgs: args,
    checkpoint,
    effectiveVersionId,
  });
}

type ExactOrUnknown<Value> =
  | { readonly classification: "exact"; readonly value: Value }
  | {
      readonly classification: "unknown";
      readonly reason: LaunchSnapshotReason;
    };

function historicalRunnerProfile(args: {
  readonly createdAtMs: number;
  readonly content: HistoricalContent;
  readonly reasons: Set<LaunchSnapshotReason>;
}): ExactOrUnknown<string> {
  if (args.content.classification === "invalid") {
    addReason(args.reasons, "legacy_content_invalid");
    return { classification: "unknown", reason: "legacy_content_invalid" };
  }
  if (args.content.classification === "unsupported") {
    addReason(args.reasons, "legacy_content_unsupported");
    return {
      classification: "unknown",
      reason: "legacy_content_unsupported",
    };
  }
  if (args.content.agent.profilePresent) {
    if (!isValidProfile(args.content.agent.profile)) {
      addReason(args.reasons, "runner_profile_invalid");
      return {
        classification: "unknown",
        reason: "runner_profile_invalid",
      };
    }
    addReason(args.reasons, "runner_profile_explicit_exact");
    return { classification: "exact", value: args.content.agent.profile };
  }
  if (args.createdAtMs < REVIEWED_RUN_LOWER_BOUND_MS) {
    addReason(args.reasons, "runner_profile_default_unproven");
    return {
      classification: "unknown",
      reason: "runner_profile_default_unproven",
    };
  }
  addReason(args.reasons, "runner_profile_default_exact");
  return { classification: "exact", value: DEFAULT_RUNNER_PROFILE };
}

function historicalVm0ModelFramework(args: {
  readonly selectedModel: string;
  readonly createdAtMs: number;
  readonly reasons: Set<LaunchSnapshotReason>;
}): ExactOrUnknown<BaseHistoricalFramework> {
  const stableRule = Object.hasOwn(
    HISTORICAL_VM0_MODEL_RULES,
    args.selectedModel,
  )
    ? HISTORICAL_VM0_MODEL_RULES[
        args.selectedModel as keyof typeof HISTORICAL_VM0_MODEL_RULES
      ]
    : undefined;
  if (stableRule) {
    addReason(args.reasons, "framework_vm0_model_exact");
    return { classification: "exact", value: stableRule };
  }
  if (args.selectedModel === "deepseek-v4-flash") {
    if (args.createdAtMs < FLASH_CODEX_ROLLOUT_START_MS) {
      addReason(args.reasons, "framework_vm0_model_exact");
      return { classification: "exact", value: "claude-code" };
    }
    if (args.createdAtMs <= FLASH_CODEX_ROLLOUT_END_MS) {
      addReason(args.reasons, "framework_vm0_model_unknown");
      return {
        classification: "unknown",
        reason: "framework_vm0_model_unknown",
      };
    }
    addReason(args.reasons, "framework_vm0_model_exact");
    return { classification: "exact", value: "codex" };
  }
  if (args.selectedModel === "deepseek-v4-pro") {
    if (args.createdAtMs < PRO_RETIREMENT_ROLLOUT_START_MS) {
      addReason(args.reasons, "framework_vm0_model_exact");
      return { classification: "exact", value: "claude-code" };
    }
    if (args.createdAtMs <= PRO_RETIREMENT_ROLLOUT_END_MS) {
      addReason(args.reasons, "framework_vm0_model_unknown");
      return {
        classification: "unknown",
        reason: "framework_vm0_model_unknown",
      };
    }
    if (args.createdAtMs < PI_PRO_ROLLOUT_START_MS) {
      addReason(args.reasons, "framework_vm0_model_retired");
      return {
        classification: "unknown",
        reason: "framework_vm0_model_retired",
      };
    }
    if (args.createdAtMs <= PRO_CODEX_ROLLOUT_END_MS) {
      addReason(args.reasons, "framework_vm0_model_unknown");
      return {
        classification: "unknown",
        reason: "framework_vm0_model_unknown",
      };
    }
    addReason(args.reasons, "framework_vm0_model_exact");
    return { classification: "exact", value: "codex" };
  }
  if (RETIRED_VM0_MODELS.has(args.selectedModel)) {
    addReason(args.reasons, "framework_vm0_model_retired");
    return {
      classification: "unknown",
      reason: "framework_vm0_model_retired",
    };
  }
  addReason(args.reasons, "framework_vm0_model_unknown");
  return {
    classification: "unknown",
    reason: "framework_vm0_model_unknown",
  };
}

function mappedProviderFramework(args: {
  readonly run: LaunchSnapshotRunInventoryRow;
  readonly createdAtMs: number;
  readonly reasons: Set<LaunchSnapshotReason>;
}): ExactOrUnknown<BaseHistoricalFramework> {
  if (args.run.modelProvider === null) throw new Error("provider is required");
  if (RETIRED_PROVIDER_TYPES.has(args.run.modelProvider)) {
    addReason(args.reasons, "framework_provider_retired");
    return {
      classification: "unknown",
      reason: "framework_provider_retired",
    };
  }
  if (args.run.modelProvider === "vm0") {
    if (
      args.run.selectedModel === null ||
      args.run.selectedModel.length === 0
    ) {
      addReason(args.reasons, "framework_vm0_model_missing");
      return {
        classification: "unknown",
        reason: "framework_vm0_model_missing",
      };
    }
    const modelFramework = historicalVm0ModelFramework({
      selectedModel: args.run.selectedModel,
      createdAtMs: args.createdAtMs,
      reasons: args.reasons,
    });
    if (modelFramework.classification === "exact") {
      addReason(args.reasons, "framework_provider_exact");
    }
    return modelFramework;
  }

  const rule = Object.hasOwn(HISTORICAL_PROVIDER_RULES, args.run.modelProvider)
    ? HISTORICAL_PROVIDER_RULES[
        args.run.modelProvider as keyof typeof HISTORICAL_PROVIDER_RULES
      ]
    : undefined;
  if (!rule) {
    addReason(args.reasons, "framework_provider_unknown");
    return {
      classification: "unknown",
      reason: "framework_provider_unknown",
    };
  }
  addReason(args.reasons, "framework_provider_exact");
  return { classification: "exact", value: rule };
}

function providerFramework(args: {
  readonly run: LaunchSnapshotRunInventoryRow;
  readonly createdAtMs: number;
  readonly legacyFramework: ExactOrUnknown<BaseHistoricalFramework>;
  readonly reasons: Set<LaunchSnapshotReason>;
}): ExactOrUnknown<BaseHistoricalFramework> {
  if (args.createdAtMs < PROVIDER_PRECEDENCE_ROLLOUT_START_MS) {
    addReason(args.reasons, "framework_provider_precedence_inactive");
    if (args.run.modelProvider === null) {
      addReason(args.reasons, "framework_provider_missing");
    }
    return args.legacyFramework;
  }
  if (args.run.modelProvider === null) {
    addReason(args.reasons, "framework_provider_missing");
    return {
      classification: "unknown",
      reason: "framework_provider_missing",
    };
  }
  const mapped = mappedProviderFramework(args);
  if (args.createdAtMs <= PROVIDER_PRECEDENCE_ROLLOUT_END_MS) {
    if (
      mapped.classification === "exact" &&
      args.legacyFramework.classification === "exact" &&
      mapped.value === args.legacyFramework.value
    ) {
      return mapped;
    }
    addReason(args.reasons, "framework_provider_rollout_transition");
    return {
      classification: "unknown",
      reason: "framework_provider_rollout_transition",
    };
  }
  return mapped;
}

type PiHistoricalWindow =
  | "none"
  | "transient_callback"
  | "callback_removal_transition"
  | "callback_removed"
  | "flash_transition"
  | "flash_only"
  | "sandbox_transition"
  | "pro_transition"
  | "flash_and_pro";

function piHistoricalWindow(createdAtMs: number): PiHistoricalWindow {
  if (createdAtMs < PI_TRANSIENT_ROLLOUT_START_MS) return "none";
  if (createdAtMs < PI_CALLBACK_REMOVAL_ROLLOUT_START_MS) {
    return "transient_callback";
  }
  if (createdAtMs <= PI_CALLBACK_REMOVAL_ROLLOUT_END_MS) {
    return "callback_removal_transition";
  }
  if (createdAtMs < PI_FLASH_ROLLOUT_START_MS) return "callback_removed";
  if (createdAtMs <= PI_FLASH_ROLLOUT_END_MS) return "flash_transition";
  if (createdAtMs < PI_SANDBOX_ROLLOUT_START_MS) return "flash_only";
  if (createdAtMs <= PI_SANDBOX_ROLLOUT_END_MS) {
    return "sandbox_transition";
  }
  if (createdAtMs < PI_PRO_ROLLOUT_START_MS) return "flash_only";
  if (createdAtMs <= PI_PRO_ROLLOUT_END_MS) return "pro_transition";
  return "flash_and_pro";
}

type HistoricalPiEligibility =
  | { readonly classification: "possible" }
  | { readonly classification: "definitively_ineligible" }
  | {
      readonly classification: "unknown";
      readonly reason:
        | "framework_pi_model_missing"
        | "framework_pi_model_unknown"
        | "framework_provider_missing";
    };

function isReviewedHistoricalModel(value: string): boolean {
  return (
    value === "deepseek-v4-flash" ||
    value === "deepseek-v4-pro" ||
    Object.hasOwn(HISTORICAL_VM0_MODEL_RULES, value) ||
    RETIRED_VM0_MODELS.has(value)
  );
}

function historicalPiEligibility(args: {
  readonly run: LaunchSnapshotRunInventoryRow;
  readonly createdAtMs: number;
  readonly baseFramework: ExactOrUnknown<BaseHistoricalFramework>;
}): HistoricalPiEligibility {
  const window = piHistoricalWindow(args.createdAtMs);
  if (window === "none") {
    return { classification: "definitively_ineligible" };
  }
  if (
    args.run.triggerSource !== null &&
    !WEB_CHAT_TRIGGER_SOURCES.has(args.run.triggerSource)
  ) {
    return { classification: "definitively_ineligible" };
  }
  if (!args.run.chatThreadPresent) {
    return { classification: "definitively_ineligible" };
  }
  if (
    args.baseFramework.classification === "exact" &&
    args.baseFramework.value === "claude-code"
  ) {
    return { classification: "definitively_ineligible" };
  }
  if (args.run.triggerSource === null) {
    return {
      classification: "unknown",
      // A schema-consistent NULL trigger also has NULL provider metadata.
      // The no-chat case returned above is exact; any future reachable case
      // still lacks provider authority and must remain unknown.
      reason: "framework_provider_missing",
    };
  }
  if (args.run.modelProvider === null) {
    return {
      classification: "unknown",
      reason: "framework_provider_missing",
    };
  }
  if (
    window === "transient_callback" ||
    window === "callback_removal_transition" ||
    window === "callback_removed" ||
    window === "flash_transition"
  ) {
    // Before the model predicate was persisted in code, provider config,
    // credentials, the feature switch, and (initially) the kickoff callback
    // were transient. A known Claude base is the only reviewed exclusion.
    return { classification: "possible" };
  }
  if (typeof args.run.selectedModel !== "string") {
    return {
      classification: "unknown",
      reason: "framework_pi_model_missing",
    };
  }
  if (args.run.selectedModel === "deepseek-v4-flash") {
    return { classification: "possible" };
  }
  const possible =
    (window === "pro_transition" || window === "flash_and_pro") &&
    args.run.selectedModel === "deepseek-v4-pro";
  if (possible) return { classification: "possible" };
  if (isReviewedHistoricalModel(args.run.selectedModel)) {
    return { classification: "definitively_ineligible" };
  }
  return {
    classification: "unknown",
    reason: "framework_pi_model_unknown",
  };
}

type FrameworkResolution =
  | { readonly classification: "exact"; readonly value: HistoricalFramework }
  | {
      readonly classification: "unknown";
      readonly reason: LaunchSnapshotReason;
    }
  | {
      readonly classification: "conflict";
      readonly reason: LaunchSnapshotReason;
    };

function historicalFramework(args: {
  readonly run: LaunchSnapshotRunInventoryRow;
  readonly createdAtMs: number;
  readonly content: HistoricalContent;
  readonly conversation: LaunchSnapshotConversationInventoryRow | undefined;
  readonly duplicateConversation: boolean;
  readonly reasons: Set<LaunchSnapshotReason>;
}): FrameworkResolution {
  let legacyFramework: ExactOrUnknown<BaseHistoricalFramework>;
  if (args.content.classification === "exact") {
    if (isBaseFramework(args.content.agent.framework)) {
      addReason(args.reasons, "framework_legacy_exact");
      legacyFramework = {
        classification: "exact",
        value: args.content.agent.framework,
      };
    } else {
      addReason(args.reasons, "legacy_content_invalid");
      legacyFramework = {
        classification: "unknown",
        reason: "legacy_content_invalid",
      };
    }
  } else {
    const reason =
      args.content.classification === "invalid"
        ? "legacy_content_invalid"
        : "legacy_content_unsupported";
    addReason(args.reasons, reason);
    legacyFramework = { classification: "unknown", reason };
  }

  const baseFramework = providerFramework({
    run: args.run,
    createdAtMs: args.createdAtMs,
    legacyFramework,
    reasons: args.reasons,
  });
  if (
    baseFramework.classification === "unknown" &&
    baseFramework.reason === "otherwise_unclassified_shape"
  ) {
    return {
      classification: "conflict",
      reason: "otherwise_unclassified_shape",
    };
  }
  const piEligibility = historicalPiEligibility({
    run: args.run,
    createdAtMs: args.createdAtMs,
    baseFramework,
  });

  if (args.duplicateConversation) {
    addReason(args.reasons, "otherwise_unclassified_shape");
    return {
      classification: "conflict",
      reason: "otherwise_unclassified_shape",
    };
  }
  if (!args.conversation) {
    addReason(args.reasons, "conversation_framework_missing");
    if (piEligibility.classification === "possible") {
      addReason(args.reasons, "framework_pi_state_unproven");
      return {
        classification: "unknown",
        reason: "framework_pi_state_unproven",
      };
    }
    if (piEligibility.classification === "unknown") {
      addReason(args.reasons, piEligibility.reason);
      return {
        classification: "unknown",
        reason: piEligibility.reason,
      };
    }
    return baseFramework;
  }
  if (!isFramework(args.conversation.framework)) {
    addReason(args.reasons, "conversation_framework_invalid");
    return {
      classification: "conflict",
      reason: "conversation_framework_invalid",
    };
  }

  addReason(args.reasons, "conversation_framework_valid");
  const conversationFramework = args.conversation.framework;
  if (conversationFramework === "pi") {
    if (piEligibility.classification === "definitively_ineligible") {
      addReason(args.reasons, "conversation_framework_conflict");
      addReason(args.reasons, "framework_evidence_conflict");
      return {
        classification: "conflict",
        reason: "conversation_framework_conflict",
      };
    }
    return { classification: "exact", value: "pi" };
  }
  if (
    baseFramework.classification === "exact" &&
    baseFramework.value !== conversationFramework
  ) {
    addReason(args.reasons, "conversation_framework_conflict");
    addReason(args.reasons, "framework_evidence_conflict");
    return {
      classification: "conflict",
      reason: "conversation_framework_conflict",
    };
  }
  return { classification: "exact", value: conversationFramework };
}

function integrityConflict(
  reason: LaunchSnapshotReason,
  reasons: Set<LaunchSnapshotReason>,
): RunClassification {
  addReason(reasons, "evidence_conflict");
  return {
    disposition: "integrity_conflict",
    primaryReason: reason,
    reasons,
  };
}

interface RunClassifierArgs {
  readonly run: LaunchSnapshotRunInventoryRow;
  readonly checkpoint: LaunchSnapshotCheckpointInventoryRow | undefined;
  readonly duplicateCheckpoint: boolean;
  readonly conversation: LaunchSnapshotConversationInventoryRow | undefined;
  readonly duplicateConversation: boolean;
  readonly versions: ReadonlyMap<string, LaunchSnapshotVersionInventoryRow>;
  readonly duplicateVersionIds: ReadonlySet<string>;
}

interface RunClassifierContext extends RunClassifierArgs {
  readonly createdAtMs: number;
  readonly reasons: Set<LaunchSnapshotReason>;
}

function isValidRunInventory(run: LaunchSnapshotRunInventoryRow): boolean {
  return (
    run.createdAt instanceof Date &&
    Number.isFinite(run.createdAt.getTime()) &&
    (run.modelProvider === null || typeof run.modelProvider === "string") &&
    (run.selectedModel === null || typeof run.selectedModel === "string") &&
    (run.triggerSource === null || typeof run.triggerSource === "string") &&
    typeof run.chatThreadPresent === "boolean" &&
    (run.metadataShape === "lifecycle_only" ||
      run.metadataShape === "product" ||
      run.metadataShape === "partial") &&
    (run.launchSnapshot !== undefined || Object.hasOwn(run, "launchSnapshot"))
  );
}

function hasConsistentRunMetadataShape(
  run: LaunchSnapshotRunInventoryRow,
): boolean {
  if (run.metadataShape === "product") {
    return typeof run.triggerSource === "string";
  }
  if (run.metadataShape === "lifecycle_only") {
    return (
      run.triggerSource === null &&
      run.modelProvider === null &&
      run.selectedModel === null &&
      !run.chatThreadPresent
    );
  }
  return false;
}

function referenceEvidenceForRun(
  context: RunClassifierContext,
): ResolvedVersionEvidence {
  return classifyReferenceEvidence({
    run: context.run,
    checkpoint: context.checkpoint,
    duplicateCheckpoint: context.duplicateCheckpoint,
    versions: context.versions,
    duplicateVersionIds: context.duplicateVersionIds,
    reasons: context.reasons,
  });
}

function recordExactHistoricalContent(
  content: HistoricalContent,
  reasons: Set<LaunchSnapshotReason>,
): void {
  if (content.classification !== "exact") return;
  addReason(reasons, "legacy_content_exact");
  addReason(reasons, "legacy_first_agent_exact");
}

function existingContentConflict(args: {
  readonly context: RunClassifierContext;
  readonly snapshot: {
    readonly framework: HistoricalFramework;
    readonly runnerProfile: string;
  };
  readonly content: unknown;
}): LaunchSnapshotReason | undefined {
  const { context, snapshot } = args;
  const content = historicalFirstAgent(args.content);
  recordExactHistoricalContent(content, context.reasons);
  const profile = historicalRunnerProfile({
    createdAtMs: context.createdAtMs,
    content,
    reasons: context.reasons,
  });
  if (
    profile.classification === "exact" &&
    profile.value !== snapshot.runnerProfile
  ) {
    addReason(context.reasons, "evidence_conflict");
    return "evidence_conflict";
  }

  const framework = historicalFramework({
    run: context.run,
    createdAtMs: context.createdAtMs,
    content,
    conversation: context.conversation,
    duplicateConversation: context.duplicateConversation,
    reasons: context.reasons,
  });
  if (framework.classification === "conflict") {
    addReason(context.reasons, "framework_evidence_conflict");
    return framework.reason;
  }
  if (
    framework.classification === "exact" &&
    framework.value !== snapshot.framework
  ) {
    addReason(context.reasons, "framework_evidence_conflict");
    return "framework_evidence_conflict";
  }
  return undefined;
}

function existingConversationConflict(args: {
  readonly context: RunClassifierContext;
  readonly snapshotFramework: HistoricalFramework;
}): LaunchSnapshotReason | undefined {
  const { context } = args;
  if (context.duplicateConversation) {
    addReason(context.reasons, "otherwise_unclassified_shape");
    return "otherwise_unclassified_shape";
  }
  if (!context.conversation) return undefined;
  if (!isFramework(context.conversation.framework)) {
    addReason(context.reasons, "conversation_framework_invalid");
    return "conversation_framework_invalid";
  }
  if (context.conversation.framework !== args.snapshotFramework) {
    addReason(context.reasons, "conversation_framework_conflict");
    return "conversation_framework_conflict";
  }
  return undefined;
}

function classifyExistingSnapshot(
  context: RunClassifierContext,
): RunClassification {
  const snapshot = strictLaunchSnapshot(context.run.launchSnapshot);
  if (!snapshot) {
    addReason(context.reasons, "existing_snapshot_invalid");
    return integrityConflict("existing_snapshot_invalid", context.reasons);
  }
  addReason(context.reasons, "existing_snapshot_valid");

  const reference = referenceEvidenceForRun(context);
  if (reference.conflictReason) {
    return integrityConflict(reference.conflictReason, context.reasons);
  }
  const conflictReason =
    reference.content === undefined
      ? existingConversationConflict({
          context,
          snapshotFramework: snapshot.framework,
        })
      : existingContentConflict({
          context,
          snapshot,
          content: reference.content,
        });
  if (conflictReason) {
    return integrityConflict(conflictReason, context.reasons);
  }
  return {
    disposition: "already_valid",
    primaryReason: "existing_snapshot_valid",
    reasons: context.reasons,
  };
}

function classifyMissingSnapshot(
  context: RunClassifierContext,
): RunClassification {
  const reference = referenceEvidenceForRun(context);
  if (reference.conflictReason) {
    return integrityConflict(reference.conflictReason, context.reasons);
  }
  if (reference.content === undefined) {
    return {
      disposition: "historical_unknown",
      primaryReason: reference.unknownReason ?? "no_version_reference",
      reasons: context.reasons,
    };
  }

  const content = historicalFirstAgent(reference.content);
  recordExactHistoricalContent(content, context.reasons);
  const profile = historicalRunnerProfile({
    createdAtMs: context.createdAtMs,
    content,
    reasons: context.reasons,
  });
  const framework = historicalFramework({
    run: context.run,
    createdAtMs: context.createdAtMs,
    content,
    conversation: context.conversation,
    duplicateConversation: context.duplicateConversation,
    reasons: context.reasons,
  });
  if (framework.classification === "conflict") {
    return integrityConflict(framework.reason, context.reasons);
  }
  if (profile.classification === "unknown") {
    return {
      disposition: "historical_unknown",
      primaryReason: profile.reason,
      reasons: context.reasons,
    };
  }
  if (framework.classification === "unknown") {
    return {
      disposition: "historical_unknown",
      primaryReason: framework.reason,
      reasons: context.reasons,
    };
  }

  addReason(context.reasons, "complete_exact_evidence");
  return {
    disposition: "exactly_recoverable",
    primaryReason: "complete_exact_evidence",
    reasons: context.reasons,
  };
}

function classifyRun(args: RunClassifierArgs): RunClassification {
  const reasons = new Set<LaunchSnapshotReason>();
  if (!isValidRunInventory(args.run)) {
    addReason(reasons, "otherwise_unclassified_shape");
    return integrityConflict("otherwise_unclassified_shape", reasons);
  }
  if (!hasConsistentRunMetadataShape(args.run)) {
    addReason(reasons, "otherwise_unclassified_shape");
    return integrityConflict("otherwise_unclassified_shape", reasons);
  }
  if (
    args.run.triggerSource !== null &&
    !HISTORICAL_TRIGGER_SOURCES.has(args.run.triggerSource)
  ) {
    addReason(reasons, "trigger_source_unrecognized");
    return integrityConflict("trigger_source_unrecognized", reasons);
  }
  const createdAtMs = args.run.createdAt.getTime();
  if (createdAtMs < REVIEWED_RUN_LOWER_BOUND_MS) {
    addReason(reasons, "created_before_reviewed_history_boundary");
  }

  const context: RunClassifierContext = {
    ...args,
    createdAtMs,
    reasons,
  };
  return args.run.launchSnapshot === null
    ? classifyMissingSnapshot(context)
    : classifyExistingSnapshot(context);
}

function closureComparison(
  domain: string,
  expected: readonly string[],
  observed: readonly string[],
  cardinalityAware = false,
): ClosureComparison {
  const expectedMetric = fingerprintSortedSet(`${domain}:expected`, expected);
  const observedMetric = fingerprintSortedSet(`${domain}:expected`, observed);
  const exactSet =
    expectedMetric.count === observedMetric.count &&
    expectedMetric.digest === observedMetric.digest;
  const exactCardinality =
    !cardinalityAware ||
    (expected.length === expectedMetric.count &&
      observed.length === observedMetric.count &&
      expected.length === observed.length);
  return {
    expected: expectedMetric,
    observed: observedMetric,
    classification: exactSet && exactCardinality ? "exact" : "drift",
  };
}

function groupedByRunId<Row extends { readonly runId: string }>(
  rows: readonly Row[],
): {
  readonly first: ReadonlyMap<string, Row>;
  readonly duplicates: ReadonlySet<string>;
} {
  const first = new Map<string, Row>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (first.has(row.runId)) duplicates.add(row.runId);
    else first.set(row.runId, row);
  }
  return { first, duplicates };
}

function reasonsAreCompatible(classified: RunClassification): boolean {
  if (!classified.reasons.has(classified.primaryReason)) return false;
  return [...classified.reasons].every((reason) => {
    return REASON_DISPOSITION_COMPATIBILITY[reason].some((disposition) => {
      return disposition === classified.disposition;
    });
  });
}

export function classifyLaunchSnapshotRecoverability(args: {
  readonly runs: readonly LaunchSnapshotRunInventoryRow[];
  readonly versions: readonly LaunchSnapshotVersionInventoryRow[];
  readonly checkpoints: readonly LaunchSnapshotCheckpointInventoryRow[];
  readonly conversations: readonly LaunchSnapshotConversationInventoryRow[];
}): {
  readonly output: {
    readonly total: number;
    readonly population: SetFingerprint;
    readonly dispositions: Readonly<
      Record<LaunchSnapshotDisposition, SetFingerprint>
    >;
    readonly reasons: Readonly<Record<LaunchSnapshotReason, SetFingerprint>>;
    readonly populationClosure: ClosureComparison;
    readonly dispositionPartitionClosure: ClosureComparison;
    readonly dispositionDisjointnessClosure: ClosureComparison;
    readonly dispositionUnionClosure: ClosureComparison;
    readonly reasonPartitionClosure: ClosureComparison;
    readonly reasonUnionClosure: ClosureComparison;
    readonly reasonCompatibilityClosure: ClosureComparison;
  };
  readonly failureGates: readonly string[];
} {
  const versions = new Map<string, LaunchSnapshotVersionInventoryRow>();
  const duplicateVersionIds = new Set<string>();
  for (const version of args.versions) {
    if (versions.has(version.id)) duplicateVersionIds.add(version.id);
    else versions.set(version.id, version);
  }
  const checkpoints = groupedByRunId(args.checkpoints);
  const conversations = groupedByRunId(args.conversations);
  const dispositionMembers = Object.fromEntries(
    LAUNCH_SNAPSHOT_DISPOSITIONS.map((disposition) => {
      return [disposition, [] as string[]];
    }),
  ) as Record<LaunchSnapshotDisposition, string[]>;
  const reasonMembers = Object.fromEntries(
    LAUNCH_SNAPSHOT_REASONS.map((reason) => {
      return [reason, [] as string[]];
    }),
  ) as Record<LaunchSnapshotReason, string[]>;
  const primaryReasonMembers: string[] = [];
  const incompatibleReasonRunIds: string[] = [];

  for (const run of args.runs) {
    const classified = classifyRun({
      run,
      checkpoint: checkpoints.first.get(run.id),
      duplicateCheckpoint: checkpoints.duplicates.has(run.id),
      conversation: conversations.first.get(run.id),
      duplicateConversation: conversations.duplicates.has(run.id),
      versions,
      duplicateVersionIds,
    });
    dispositionMembers[classified.disposition].push(run.id);
    primaryReasonMembers.push(run.id);
    if (!reasonsAreCompatible(classified)) {
      incompatibleReasonRunIds.push(run.id);
    }
    for (const reason of classified.reasons) reasonMembers[reason].push(run.id);
  }

  const runIds = args.runs.map((run) => {
    return run.id;
  });
  const uniqueRunIds = [...new Set(runIds)];
  const dispositionAssignments = LAUNCH_SNAPSHOT_DISPOSITIONS.flatMap(
    (disposition) => {
      return dispositionMembers[disposition];
    },
  );
  const dispositionCounts = new Map<string, number>();
  for (const runId of dispositionAssignments) {
    dispositionCounts.set(runId, (dispositionCounts.get(runId) ?? 0) + 1);
  }
  const duplicateDispositionRunIds = [...dispositionCounts]
    .filter(([, count]) => {
      return count > 1;
    })
    .map(([runId]) => {
      return runId;
    });
  const reasonAssignments = LAUNCH_SNAPSHOT_REASONS.flatMap((reason) => {
    return reasonMembers[reason];
  });

  const populationClosure = closureComparison(
    "launch-snapshots:population-closure:v4",
    runIds,
    uniqueRunIds,
    true,
  );
  const dispositionPartitionClosure = closureComparison(
    "launch-snapshots:disposition-partition-closure:v4",
    runIds,
    dispositionAssignments,
    true,
  );
  const dispositionDisjointnessClosure = closureComparison(
    "launch-snapshots:disposition-disjointness-closure:v4",
    [],
    duplicateDispositionRunIds,
  );
  const dispositionUnionClosure = closureComparison(
    "launch-snapshots:disposition-union-closure:v4",
    runIds,
    dispositionAssignments,
  );
  const reasonPartitionClosure = closureComparison(
    "launch-snapshots:reason-partition-closure:v4",
    runIds,
    primaryReasonMembers,
    true,
  );
  const reasonUnionClosure = closureComparison(
    "launch-snapshots:reason-union-closure:v4",
    runIds,
    reasonAssignments,
  );
  const reasonCompatibilityClosure = closureComparison(
    "launch-snapshots:reason-compatibility-closure:v4",
    [],
    incompatibleReasonRunIds,
  );

  const closureResults = [
    populationClosure,
    dispositionPartitionClosure,
    dispositionDisjointnessClosure,
    dispositionUnionClosure,
    reasonPartitionClosure,
    reasonUnionClosure,
    reasonCompatibilityClosure,
  ];
  const failureGates = new Set<string>();
  if (
    dispositionMembers.integrity_conflict.length > 0 ||
    duplicateVersionIds.size > 0 ||
    checkpoints.duplicates.size > 0 ||
    conversations.duplicates.size > 0
  ) {
    failureGates.add("launchSnapshots.integrity_conflict");
  }
  if (
    closureResults.some((closure) => {
      return closure.classification === "drift";
    })
  ) {
    failureGates.add("launchSnapshots.closure");
  }
  if (reasonMembers.created_before_reviewed_history_boundary.length > 0) {
    failureGates.add("launchSnapshots.history_boundary");
  }

  return {
    output: {
      total: args.runs.length,
      population: fingerprintSortedSet(
        "launch-snapshots:population-run-ids:v4",
        runIds,
      ),
      dispositions: Object.fromEntries(
        LAUNCH_SNAPSHOT_DISPOSITIONS.map((disposition) => {
          return [
            disposition,
            fingerprintSortedSet(
              `launch-snapshots:disposition:${disposition}:run-ids:v4`,
              dispositionMembers[disposition],
            ),
          ];
        }),
      ) as Record<LaunchSnapshotDisposition, SetFingerprint>,
      reasons: Object.fromEntries(
        LAUNCH_SNAPSHOT_REASONS.map((reason) => {
          return [
            reason,
            fingerprintSortedSet(
              `launch-snapshots:reason:${reason}:run-ids:v4`,
              reasonMembers[reason],
            ),
          ];
        }),
      ) as Record<LaunchSnapshotReason, SetFingerprint>,
      populationClosure,
      dispositionPartitionClosure,
      dispositionDisjointnessClosure,
      dispositionUnionClosure,
      reasonPartitionClosure,
      reasonUnionClosure,
      reasonCompatibilityClosure,
    },
    failureGates: [...failureGates].sort(),
  };
}
