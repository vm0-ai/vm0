import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  bigint,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { RunFailureReason } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { agents } from "./agent";
import { registerAgentRunReferences } from "./agent-run-reference";
import { chatThreads } from "./chat-thread";
import { threadGoals } from "./thread-goal";
import { workflowAutomations } from "./workflow";
import type {
  AgentRunLaunchSnapshot,
  AgentRunOfficialWorkflowProvenance,
  AgentRunResult,
  AgentRunSecretNames,
  AgentRunStorageMounts,
  AgentRunVars,
  AgentSessionStorageMounts,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";

/**
 * Agent Runs table
 * Created when developer executes agent via SDK
 * Stores an immutable launch snapshot for reproducibility.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID - owner of this run
    continuedFromSessionId: uuid("continued_from_session_id"),
    sessionId: uuid("session_id")
      .notNull()
      .references(
        (): AnyPgColumn => {
          return agentSessions.id;
        },
        { onDelete: "cascade" },
      ),
    status: varchar("status", { length: 20 }).notNull(),
    prompt: text("prompt").notNull(),
    appendSystemPrompt: text("append_system_prompt"),
    vars: jsonb("vars").$type<AgentRunVars>(),
    // Secret names for validation (values never stored - must be provided at runtime)
    secretNames: jsonb("secret_names").$type<AgentRunSecretNames>(),
    // Canonical resolved mounts used by new run writers.
    storageMounts: jsonb("storage_mounts").$type<AgentRunStorageMounts>(),
    launchSnapshot: jsonb("launch_snapshot").$type<AgentRunLaunchSnapshot>(),
    // Exact accepted Definition inputs mounted for this Run. Null preserves
    // historical and non-Official producers during the additive rollout.
    officialWorkflowProvenance: jsonb(
      "official_workflow_provenance",
    ).$type<AgentRunOfficialWorkflowProvenance>(),
    sandboxId: varchar("sandbox_id", { length: 255 }),
    // One of: "reused" | "featureDisabled" | "noSessionId" | "noReuseKey" |
    // "poolMiss" | "profileMismatch" | "deviceLimitMismatch" | "unparkFailed".
    // Null means unknown (old runner or historical row); "noSessionId" is a
    // legacy ambiguous result.
    sandboxReuseResult: varchar("sandbox_reuse_result", { length: 50 }),
    // Final workspace reuse outcome after sandbox preparation. Null means the
    // runner did not reach a reliable decision or predates this field.
    workspaceReuseResult: varchar("workspace_reuse_result", { length: 50 }),
    // Null identifies a historical claim without cancellation recovery.
    // Current claims initialize false; false/true records whether recovery
    // completion has been reported. The barrier is active only while the
    // public run status is cancelled.
    cancellationRecoveryCompleted: boolean("cancellation_recovery_completed"),
    result: jsonb("result").$type<AgentRunResult>(),
    error: text("error"),
    failureReason: text("failure_reason").$type<RunFailureReason>(),
    lastEventSequence: integer("last_event_sequence"),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    // Immutable winning official claim attribution. ID/generation is the
    // authority; hostname/version are diagnostic snapshots. Null covers
    // historical, rollout-omitting, and non-official claims.
    runnerId: uuid("runner_id"),
    runnerHeartbeatGeneration: bigint("runner_heartbeat_generation", {
      mode: "number",
    }),
    runnerHostname: varchar("runner_hostname", { length: 255 }),
    runnerVersion: varchar("runner_version", { length: 128 }),
    activeInputEnabled: boolean("active_input_enabled")
      .default(false)
      .notNull(),
    runnerGroup: varchar("runner_group", { length: 255 }),
    // Null discriminators identify accepted lifecycle-only history where all
    // product metadata is absent. Product runs write both fields together.
    triggerSource: varchar("trigger_source", { length: 20 }),
    autonomyBudget: integer("autonomy_budget"),
    workflowAutomationId: uuid("workflow_automation_id").references(
      (): AnyPgColumn => {
        return workflowAutomations.id;
      },
      { onDelete: "set null" },
    ),
    goalId: uuid("goal_id").references(
      (): AnyPgColumn => {
        return threadGoals.id;
      },
      { onDelete: "set null" },
    ),
    modelProvider: varchar("model_provider", { length: 100 }),
    modelProviderId: uuid("model_provider_id"),
    modelProviderCredentialScope: varchar("model_provider_credential_scope", {
      length: 20,
    }),
    selectedModel: varchar("selected_model", { length: 255 }),
    modelRuntimeProvider: varchar("model_runtime_provider", { length: 100 }),
    modelRuntimeModel: varchar("model_runtime_model", { length: 255 }),
    builtInModelKeyId: uuid("built_in_model_key_id"),
    codexServiceTier: varchar("codex_service_tier", {
      length: 20,
    }).$type<CodexServiceTier>(),
    selectedVideoModel: varchar("selected_video_model", { length: 255 }),
    /** Built-in image model default snapshotted for this run. */
    selectedImageModel: varchar("selected_image_model", { length: 255 }),
    chatThreadId: uuid("chat_thread_id").references(
      (): AnyPgColumn => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    apiStartedAt: timestamp("api_started_at"),
    firstAssistantEventAcknowledgedAt: timestamp(
      "first_assistant_event_acknowledged_at",
    ),
    summary: text("summary"),
    triggerBrief: text("trigger_brief"),
  },
  (table) => {
    return [
      // Composite index for user listing with time-based sorting
      index("idx_agent_runs_user_created").on(
        table.userId,
        table.createdAt.desc(),
      ),
      index("idx_agent_runs_org").on(table.orgId),
      // Composite index for status-based heartbeat queries
      index("idx_agent_runs_status_heartbeat").on(
        table.status,
        table.lastHeartbeatAt,
      ),
      // Partial index for cron cleanup (only running status)
      index("idx_agent_runs_running_heartbeat")
        .on(table.lastHeartbeatAt)
        .where(sql`status = 'running'`),
      // Composite index for org+status queries (concurrency checks, queue listing)
      index("idx_agent_runs_org_status_created").on(
        table.orgId,
        table.status,
        table.createdAt.desc(),
      ),
      index("idx_agent_runs_session").on(table.sessionId),
      index("idx_agent_runs_chat_thread_id")
        .on(table.chatThreadId)
        .where(sql`${table.chatThreadId} IS NOT NULL`),
      index("idx_agent_runs_workflow_automation")
        .on(table.workflowAutomationId)
        .where(sql`${table.workflowAutomationId} IS NOT NULL`),
      index("idx_agent_runs_goal")
        .on(table.goalId)
        .where(sql`${table.goalId} IS NOT NULL`),
      check(
        "agent_runs_autonomy_budget_check",
        sql`${table.autonomyBudget} >= 0 AND ${table.autonomyBudget} <= 10`,
      ),
      check(
        "agent_runs_metadata_presence_check",
        sql`(
          (
            ${table.triggerSource} IS NULL AND
            ${table.autonomyBudget} IS NULL AND
            ${table.workflowAutomationId} IS NULL AND
            ${table.goalId} IS NULL AND
            ${table.modelProvider} IS NULL AND
            ${table.modelProviderId} IS NULL AND
            ${table.modelProviderCredentialScope} IS NULL AND
            ${table.selectedModel} IS NULL AND
            ${table.modelRuntimeProvider} IS NULL AND
            ${table.modelRuntimeModel} IS NULL AND
            ${table.builtInModelKeyId} IS NULL AND
            ${table.codexServiceTier} IS NULL AND
            ${table.selectedVideoModel} IS NULL AND
            ${table.selectedImageModel} IS NULL AND
            ${table.chatThreadId} IS NULL AND
            ${table.apiStartedAt} IS NULL AND
            ${table.firstAssistantEventAcknowledgedAt} IS NULL AND
            ${table.summary} IS NULL AND
            ${table.triggerBrief} IS NULL
          ) OR (
            ${table.triggerSource} IS NOT NULL AND
            ${table.autonomyBudget} IS NOT NULL
          )
        )`,
      ),
      check(
        "agent_runs_launch_snapshot_check",
        sql`(
          ${table.launchSnapshot} IS NULL OR (
            jsonb_typeof(${table.launchSnapshot}) = 'object' AND
            ${table.launchSnapshot} ?& ARRAY[
              'schemaVersion',
              'framework',
              'runnerProfile'
            ] AND
            (
              ${table.launchSnapshot} -
              'schemaVersion' -
              'framework' -
              'runnerProfile'
            ) = '{}'::jsonb AND
            ${table.launchSnapshot} -> 'schemaVersion' = '1'::jsonb AND
            jsonb_typeof(${table.launchSnapshot} -> 'framework') = 'string' AND
            ${table.launchSnapshot} ->> 'framework' = ANY (
              ARRAY['claude-code', 'codex', 'pi']
            ) AND
            jsonb_typeof(
              ${table.launchSnapshot} -> 'runnerProfile'
            ) = 'string' AND
            char_length(${table.launchSnapshot} ->> 'runnerProfile') >= 1 AND
            char_length(${table.launchSnapshot} ->> 'runnerProfile') <= 255
          )
        )`,
      ),
      check(
        "agent_runs_official_workflow_provenance_check",
        sql`(
          ${table.officialWorkflowProvenance} IS NULL OR (
            jsonb_typeof(${table.officialWorkflowProvenance}) = 'object' AND
            ${table.officialWorkflowProvenance} ?& ARRAY[
              'schemaVersion',
              'definitions'
            ] AND
            (
              ${table.officialWorkflowProvenance} -
              'schemaVersion' -
              'definitions'
            ) = '{}'::jsonb AND
            ${table.officialWorkflowProvenance} -> 'schemaVersion' = '1'::jsonb AND
            jsonb_typeof(
              ${table.officialWorkflowProvenance} -> 'definitions'
            ) = 'array' AND
            jsonb_array_length(
              ${table.officialWorkflowProvenance} -> 'definitions'
            ) > 0 AND
            NOT jsonb_path_exists(
              ${table.officialWorkflowProvenance},
              '$.definitions[*] ? (
                @.type() != "object" ||
                !exists(@.name) ||
                @.name.type() != "string" ||
                !(@.name like_regex "^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$") ||
                !exists(@.revision) ||
                @.revision.type() != "string" ||
                !(@.revision like_regex "^[0-9a-f]{64}$") ||
                !exists(@.artifact) ||
                @.artifact.type() != "object" ||
                exists(
                  @.keyvalue() ? (
                    @.key != "name" &&
                    @.key != "revision" &&
                    @.key != "artifact"
                  )
                ) ||
                !exists(@.artifact.orgId) ||
                @.artifact.orgId != "__system__" ||
                !exists(@.artifact.userId) ||
                @.artifact.userId != "__org__" ||
                !exists(@.artifact.storageName) ||
                @.artifact.storageName.type() != "string" ||
                !(@.artifact.storageName like_regex "^.{1,255}.?$") ||
                !exists(@.artifact.storageId) ||
                @.artifact.storageId.type() != "string" ||
                !(@.artifact.storageId like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") ||
                !exists(@.artifact.storageVersion) ||
                @.artifact.storageVersion.type() != "string" ||
                !(@.artifact.storageVersion like_regex "^[0-9a-f]{64}$") ||
                exists(
                  @.artifact.keyvalue() ? (
                    @.key != "orgId" &&
                    @.key != "userId" &&
                    @.key != "storageName" &&
                    @.key != "storageId" &&
                    @.key != "storageVersion"
                  )
                )
              )'
            )
          )
        )`,
      ),
    ];
  },
);

/**
 * Agent Sessions table
 * Lightweight Agent-to-conversation association for continue operations.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
    conversationId: uuid("conversation_id").references(
      (): AnyPgColumn => {
        return conversations.id;
      },
      {
        onDelete: "set null",
      },
    ),
    // Canonical writeback mounts used by session continuation.
    storageMounts: jsonb("storage_mounts").$type<AgentSessionStorageMounts>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_agent_sessions_user_agent").on(table.userId, table.agentId),
      index("idx_agent_sessions_org").on(table.orgId),
    ];
  },
);

/**
 * Conversations table
 * Stores CLI agent conversation history for checkpoint resumption
 *
 * Session history storage strategy:
 * - Resumable new records use cliAgentSessionHistoryHash (R2 blob reference)
 * - Intentionally historyless checkpoints leave both history fields null
 * - Legacy records use cliAgentSessionHistory (TEXT field)
 * - Read logic: use the hash-backed path when present; use TEXT only for
 *   legacy rows that do not have a hash
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(
      (): AnyPgColumn => {
        return agentRuns.id;
      },
      { onDelete: "cascade" },
    )
    .notNull()
    .unique(),
  cliAgentType: varchar("cli_agent_type", { length: 64 }).notNull(),
  cliAgentSessionId: varchar("cli_agent_session_id", { length: 255 }).notNull(),
  /** @deprecated Legacy TEXT storage - new records use hash instead */
  cliAgentSessionHistory: text("cli_agent_session_history"),
  /** SHA-256 hash of the raw session history bytes stored in R2 */
  cliAgentSessionHistoryHash: varchar("cli_agent_session_history_hash", {
    length: 64,
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

registerAgentRunReferences({
  agentRunId: agentRuns.id,
  agentSessionId: agentSessions.id,
});
