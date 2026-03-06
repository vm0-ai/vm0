#!/usr/bin/env tsx

import postgres from "postgres";
import { createHash } from "crypto";

/**
 * Create a scope for a Clerk user
 * Usage: pnpm tsx scripts/create-user-scope.ts <clerk-user-id>
 */
async function main() {
  const clerkUserId = process.argv[2];

  if (!clerkUserId) {
    console.error(
      "Usage: pnpm tsx scripts/create-user-scope.ts <clerk-user-id>",
    );
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    console.log(`Creating scope for user: ${clerkUserId}`);

    // Generate slug
    const hash = createHash("sha256").update(clerkUserId).digest("hex");
    const slug = `user-${hash.slice(0, 8)}`;
    console.log(`Generated slug: ${slug}`);

    // Check if user already has a scope
    const existing = await sql`
      SELECT id, slug FROM scopes 
      WHERE owner_id = ${clerkUserId} AND type = 'personal' 
      LIMIT 1
    `;

    if (existing.length > 0) {
      console.log("ℹ️  User already has a scope:");
      console.log(`   ID: ${existing[0].id}`);
      console.log(`   Slug: ${existing[0].slug}`);
      return;
    }

    // Create the scope
    const result = await sql`
      INSERT INTO scopes (slug, type, owner_id)
      VALUES (${slug}, 'personal', ${clerkUserId})
      RETURNING id, slug, type, owner_id
    `;

    console.log("✅ Scope created successfully!");
    console.log(`   ID: ${result[0].id}`);
    console.log(`   Slug: ${result[0].slug}`);
    console.log(`   Type: ${result[0].type}`);
    console.log(`   Owner ID: ${result[0].owner_id}`);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

await main();
