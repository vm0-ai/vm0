import {
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { builtInModelKeys } from "./built-in-model-key";

export const managedModelCredentialCooldown = pgTable(
  "managed_model_credential_cooldown",
  {
    modelKeyId: uuid("model_key_id")
      .notNull()
      .references(
        () => {
          return builtInModelKeys.id;
        },
        { onDelete: "cascade" },
      ),
    unavailableUntil: timestamp("unavailable_until").notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.modelKeyId] })];
  },
);

export const managedModelCandidateCooldown = pgTable(
  "managed_model_candidate_cooldown",
  {
    selectedModel: varchar("selected_model", { length: 255 }).notNull(),
    providerType: varchar("provider_type", { length: 100 }).notNull(),
    upstreamModel: varchar("upstream_model", { length: 255 }).notNull(),
    unavailableUntil: timestamp("unavailable_until").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.selectedModel, table.providerType, table.upstreamModel],
      }),
    ];
  },
);
