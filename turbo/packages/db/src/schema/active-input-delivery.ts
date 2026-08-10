import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";
import { chatEvents } from "./chat-event";
import { chatThreads } from "./chat-thread";

export const activeInputDeliveries = pgTable(
  "active_input_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    chatThreadId: uuid("chat_thread_id")
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    status: text("status")
      .$type<"open" | "settled">()
      .default("open")
      .notNull(),
  },
  (table) => {
    return [
      uniqueIndex("active_input_deliveries_run_open_unique")
        .on(table.runId)
        .where(sql`${table.status} = 'open'`),
      index("active_input_deliveries_thread_open_idx")
        .on(table.chatThreadId)
        .where(sql`${table.status} = 'open'`),
      check(
        "active_input_deliveries_status_check",
        sql`${table.status} IN ('open', 'settled')`,
      ),
    ];
  },
);

export const activeInputDeliveryItems = pgTable(
  "active_input_delivery_items",
  {
    deliveryId: uuid("delivery_id")
      .references(
        () => {
          return activeInputDeliveries.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    sourceEventId: uuid("source_event_id")
      .references(
        () => {
          return chatEvents.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    position: integer("position").notNull(),
    disposition: text("disposition").$type<
      "delivered" | "released" | "expired"
    >(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.deliveryId, table.sourceEventId] }),
      uniqueIndex("active_input_delivery_items_delivery_position_unique").on(
        table.deliveryId,
        table.position,
      ),
      uniqueIndex("active_input_delivery_items_source_open_unique")
        .on(table.sourceEventId)
        .where(sql`${table.disposition} IS NULL`),
      check(
        "active_input_delivery_items_position_check",
        sql`${table.position} >= 0`,
      ),
      check(
        "active_input_delivery_items_disposition_check",
        sql`${table.disposition} IS NULL OR ${table.disposition} IN ('delivered', 'released', 'expired')`,
      ),
    ];
  },
);
