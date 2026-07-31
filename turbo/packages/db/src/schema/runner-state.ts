import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import type {
  RunnerAdmittableProfiles,
  RunnerHeldSessionStates,
  RunnerHeldWorkspaceStates,
} from "@vm0/db/jsonb-contracts/runner-state";
export type {
  RunnerHeldSessionState,
  RunnerHeldWorkspaceState,
} from "@vm0/db/jsonb-contracts/runner-state";

export const runnerState = pgTable(
  "runner_state",
  {
    runnerId: uuid("runner_id").primaryKey(),
    runnerName: varchar("runner_name", { length: 255 }).notNull(),
    runnerGroup: varchar("runner_group", { length: 255 }).notNull(),
    heartbeatGeneration: bigint("heartbeat_generation", {
      mode: "number",
    })
      .notNull()
      .default(0),
    heartbeatSequence: bigint("heartbeat_sequence", { mode: "number" })
      .notNull()
      .default(0),
    totalVcpu: integer("total_vcpu").notNull().default(0),
    totalMemoryMb: integer("total_memory_mb").notNull().default(0),
    maxConcurrent: integer("max_concurrent").notNull().default(0),
    allocatedVcpu: integer("allocated_vcpu").notNull().default(0),
    allocatedMemoryMb: integer("allocated_memory_mb").notNull().default(0),
    runningCount: integer("running_count").notNull().default(0),
    admittableProfiles: jsonb("admittable_profiles")
      .$type<RunnerAdmittableProfiles>()
      .default([])
      .notNull(),
    heldSessionStates: jsonb("held_session_states")
      .$type<RunnerHeldSessionStates>()
      .default([])
      .notNull(),
    heldWorkspaceStates: jsonb("held_workspace_states")
      .$type<RunnerHeldWorkspaceStates>()
      .default([])
      .notNull(),
    mode: varchar("mode", { length: 20 }).notNull().default("running"),
    lastSeenAt: timestamp("last_seen_at").notNull(),
  },
  (table) => {
    return [
      index("runner_state_group_idx").on(table.runnerGroup),
      index("runner_state_last_seen_idx").on(table.lastSeenAt),
    ];
  },
);
