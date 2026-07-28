import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { zeroWorkflowAutomations } from "./zero-workflow";

export const strapiIntegrations = pgTable(
  "strapi_integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    baseUrl: text("base_url").notNull(),
    normalizedBaseUrl: text("normalized_base_url").notNull(),
    tokenHash: text("token_hash").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    secretLastFour: varchar("secret_last_four", { length: 4 }).notNull(),
    lastTestedAt: timestamp("last_tested_at"),
    lastReceivedAt: timestamp("last_received_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_strapi_integrations_org").on(table.orgId),
      uniqueIndex("idx_strapi_integrations_org_base_url").on(
        table.orgId,
        table.normalizedBaseUrl,
      ),
      uniqueIndex("idx_strapi_integrations_token_hash").on(table.tokenHash),
    ];
  },
);

export const zeroWorkflowStrapiAutomations = pgTable(
  "zero_workflow_strapi_automations",
  {
    automationId: uuid("automation_id")
      .primaryKey()
      .references(
        () => {
          return zeroWorkflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    integrationId: uuid("integration_id")
      .notNull()
      .references(
        () => {
          return strapiIntegrations.id;
        },
        { onDelete: "restrict" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_zero_workflow_strapi_automations_integration").on(
        table.integrationId,
      ),
    ];
  },
);

export const strapiWebhookDeliveries = pgTable(
  "strapi_webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(
        () => {
          return strapiIntegrations.id;
        },
        { onDelete: "cascade" },
      ),
    bodySha256: text("body_sha256").notNull(),
    event: varchar("event", { length: 64 }).notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_strapi_webhook_deliveries_integration_body").on(
        table.integrationId,
        table.bodySha256,
      ),
      index("idx_strapi_webhook_deliveries_received").on(table.receivedAt),
    ];
  },
);

export type StrapiWorkflowPendingEventStatus =
  | "pending"
  | "running"
  | "processed"
  | "skipped";

export const strapiWorkflowPendingEvents = pgTable(
  "strapi_workflow_pending_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    integrationId: uuid("integration_id")
      .notNull()
      .references(
        () => {
          return strapiIntegrations.id;
        },
        { onDelete: "cascade" },
      ),
    uid: varchar("uid", { length: 255 }).notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    documentId: varchar("document_id", { length: 255 }).notNull(),
    locales: text("locales").array().notNull(),
    status: varchar("status", { length: 32 })
      .$type<StrapiWorkflowPendingEventStatus>()
      .notNull()
      .default("pending"),
    firstEventAt: timestamp("first_event_at").notNull(),
    latestEventAt: timestamp("latest_event_at").notNull(),
    runAfter: timestamp("run_after").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    skipReason: text("skip_reason"),
    processedAt: timestamp("processed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_strapi_pending_events_automation_document_active")
        .on(table.automationId, table.uid, table.documentId)
        .where(sql`status = 'pending'`),
      index("idx_strapi_pending_events_due").on(table.status, table.runAfter),
      index("idx_strapi_pending_events_integration").on(table.integrationId),
    ];
  },
);
