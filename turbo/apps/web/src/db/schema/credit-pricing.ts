import {
  pgTable,
  uuid,
  varchar,
  bigint,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Model-to-credit pricing configuration.
 * Maps each model identifier to its credit cost per 1M tokens.
 */
export const creditPricing = pgTable(
  "credit_pricing",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    model: varchar("model", { length: 255 }).notNull(),
    inputTokenPrice: bigint("input_token_price", { mode: "number" }).notNull(),
    outputTokenPrice: bigint("output_token_price", {
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("uq_credit_pricing_model").on(table.model)],
);
