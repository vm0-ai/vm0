import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { sshConnections } from "./ssh-connection";

export const sshConnectionCredentials = pgTable("ssh_connection_credentials", {
  connectionId: uuid("connection_id")
    .primaryKey()
    .references(
      () => {
        return sshConnections.id;
      },
      { onDelete: "cascade" },
    ),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  encryptedPassphrase: text("encrypted_passphrase"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
