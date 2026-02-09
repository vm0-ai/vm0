#!/usr/bin/env tsx

/**
 * Self-hosted initialization script.
 *
 * Runs after database migrations to ensure the self-hosted environment
 * has a default user and scope. Idempotent -- safe to run on every boot.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql as sqlTag } from "drizzle-orm";
import postgres from "postgres";

// Inline table references to avoid importing the full app schema
// (this script runs standalone in the Docker container).
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";

const scopeTypeEnum = pgEnum("scope_type", [
  "personal",
  "organization",
  "system",
]);

const scopes = pgTable("scopes", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  type: scopeTypeEnum("type").notNull().default("personal"),
  ownerId: text("owner_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  scopeId: uuid("scope_id").references(() => scopes.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Must match SELF_HOSTED_USER_ID in auth-provider.ts
const SELF_HOSTED_USER_ID = "00000000-0000-0000-0000-000000000000";
const SELF_HOSTED_SCOPE_SLUG = "self-hosted";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);

  try {
    // Check if the default user already exists
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, SELF_HOSTED_USER_ID))
      .limit(1);

    if (existing.length > 0) {
      console.log("[VM0] Default user already exists, skipping init");
      return;
    }

    // Create scope for the default user
    const [scope] = await db
      .insert(scopes)
      .values({
        slug: SELF_HOSTED_SCOPE_SLUG,
        type: "personal",
        ownerId: SELF_HOSTED_USER_ID,
      })
      .onConflictDoNothing()
      .returning({ id: scopes.id });

    // If scope already existed, look it up
    let scopeId = scope?.id;
    if (!scopeId) {
      const [existingScope] = await db
        .select({ id: scopes.id })
        .from(scopes)
        .where(eq(scopes.slug, SELF_HOSTED_SCOPE_SLUG))
        .limit(1);
      scopeId = existingScope?.id;
    }

    // Create the default user with the well-known UUID
    await db.execute(
      sqlTag`INSERT INTO users (id, scope_id, created_at, updated_at)
             VALUES (${SELF_HOSTED_USER_ID}, ${scopeId}, NOW(), NOW())
             ON CONFLICT (id) DO NOTHING`,
    );

    console.log("[VM0] Default user created: " + SELF_HOSTED_USER_ID);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[VM0] Self-hosted initialization failed:", err);
  process.exit(1);
});
