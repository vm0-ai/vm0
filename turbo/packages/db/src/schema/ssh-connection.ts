import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const sshConnections = pgTable(
  "ssh_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    host: varchar("host", { length: 253 }).notNull(),
    port: integer("port").notNull().default(22),
    username: varchar("username", { length: 255 }).notNull(),
    learnedHostKeyAlgorithm: varchar("learned_host_key_algorithm", {
      length: 64,
    }),
    learnedHostKeyFingerprint: varchar("learned_host_key_fingerprint", {
      length: 64,
    }),
    generation: integer("generation").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_ssh_connections_owner_host_port").on(
        table.orgId,
        table.userId,
        table.host,
        table.port,
      ),
      index("idx_ssh_connections_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      check(
        "chk_ssh_connections_display_name",
        sql`char_length(${table.displayName}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_ssh_connections_host",
        sql`char_length(${table.host}) BETWEEN 1 AND 253`,
      ),
      check("chk_ssh_connections_port", sql`${table.port} BETWEEN 1 AND 65535`),
      check(
        "chk_ssh_connections_username",
        sql`char_length(${table.username}) BETWEEN 1 AND 255`,
      ),
      check("chk_ssh_connections_generation", sql`${table.generation} > 0`),
      check(
        "chk_ssh_connections_learned_host_key_pair",
        sql`(${table.learnedHostKeyAlgorithm} IS NULL) = (${table.learnedHostKeyFingerprint} IS NULL)`,
      ),
    ];
  },
);
