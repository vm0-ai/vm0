import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";
import { chatThreads } from "./chat-thread";

/**
 * Automations table
 *
 * First-class, unified target schema for the Automation model (events-first).
 * An automation pairs a user intent (`instruction`) with an agent and a linked
 * chat thread; an interpreter turns the instruction plus a trigger event into
 * a concrete run prompt. The webhook trigger kind ships first; the `time` kind
 * lands when schedules are migrated in a later slice.
 *
 * Each automation carries its own (orgId, userId) pair for execution identity,
 * mirroring the schedule precedent so cross-org sharing resolves secrets from
 * the owning user/org.
 */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    description: text("description"),

    // The user intent the interpreter turns into a run prompt.
    instruction: text("instruction").notNull(),

    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      ),

    // Linked chat thread: every automation posts its runs into this thread and
    // renders as a web-chat turn. ON DELETE CASCADE: deleting the thread deletes
    // the automation linked to it (mirrors the schedule precedent).
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),

    // Which interpreter turns trigger events into prompts, e.g. "webhook".
    interpreterKind: varchar("interpreter_kind", { length: 32 }).notNull(),

    enabled: boolean("enabled").default(true).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_automations_agent").on(table.agentId),
      index("idx_automations_org").on(table.orgId),
      index("idx_automations_user_org").on(table.userId, table.orgId),
      index("idx_automations_chat_thread").on(table.chatThreadId),
      uniqueIndex("idx_automations_agent_name_org_user").on(
        table.agentId,
        table.name,
        table.orgId,
        table.userId,
      ),
    ];
  },
);

/**
 * Automation triggers table
 *
 * The event source(s) that fire an automation. `kind` discriminates the trigger
 * type ("webhook" for now); `config` holds kind-specific extensibility as jsonb.
 *
 * For webhook triggers:
 * - `webhookToken` is the unguessable, indexed-unique URL token used for O(1)
 *   inbound lookup (identity).
 * - `encryptedSecret` stores the HMAC signing secret, encrypted with the API
 *   stored-secret encryption envelope (reused from the secrets table).
 */
export const automationTriggers = pgTable(
  "automation_triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return automations.id;
        },
        { onDelete: "cascade" },
      ),

    // Trigger kind discriminator: "webhook" for now.
    kind: varchar("kind", { length: 32 }).notNull(),

    // Kind-specific extensibility.
    config: jsonb("config").$type<Record<string, unknown>>(),

    // Unguessable URL token for O(1) inbound webhook lookup (identity).
    webhookToken: varchar("webhook_token", { length: 64 }),

    // HMAC signing secret, encrypted with the API stored-secret envelope.
    encryptedSecret: text("encrypted_secret"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_automation_triggers_automation").on(table.automationId),
      uniqueIndex("idx_automation_triggers_webhook_token").on(
        table.webhookToken,
      ),
    ];
  },
);
