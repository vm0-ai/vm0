import {
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { feishuOrgInstallations } from "./feishu-org-installation";

/**
 * Durable Feishu event receipt used to prevent provider retries from
 * dispatching the same message more than once.
 */
export const feishuOrgEvents = pgTable(
  "feishu_org_events",
  {
    installationId: uuid("installation_id")
      .notNull()
      .references(
        () => {
          return feishuOrgInstallations.id;
        },
        { onDelete: "cascade" },
      ),
    eventId: varchar("event_id", { length: 255 }).notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.installationId, table.eventId],
        name: "feishu_org_events_pkey",
      }),
    ];
  },
);
