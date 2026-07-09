/**
 * In-process test fixture for the global `usage_pricing` table.
 *
 * Usage pricing is operator-managed global configuration with no product API
 * (rows are written by ops tooling/migrations in production), so tests cannot
 * construct or clear pricing state through any product endpoint. This module
 * is the narrow test-boundary exception for that state: it only upserts,
 * ensures, and deletes pricing rows keyed by (kind, provider, category).
 */
import { createStore } from "ccstate";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";

import { writeDb$, type Db } from "../signals/external/db";

export interface UsagePricingRow {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly unitPrice: number;
  readonly unitSize: number;
}

function fixtureDb(): Db {
  return createStore().set(writeDb$);
}

export async function upsertUsagePricingRows(
  rows: readonly UsagePricingRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await fixtureDb()
    .insert(usagePricing)
    .values([...rows])
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: sql`excluded.unit_size`,
        updatedAt: sql`now()`,
      },
    });
}

export async function ensureUsagePricingRow(row: UsagePricingRow): Promise<{
  readonly pricing: UsagePricingRow;
  readonly inserted: boolean;
}> {
  const db = fixtureDb();
  const [existing] = await db
    .select({
      kind: usagePricing.kind,
      provider: usagePricing.provider,
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, row.kind),
        eq(usagePricing.provider, row.provider),
        eq(usagePricing.category, row.category),
      ),
    )
    .limit(1);

  if (existing) {
    return { pricing: existing, inserted: false };
  }

  await db.insert(usagePricing).values(row);
  return { pricing: row, inserted: true };
}

export async function deleteUsagePricingRows(filter: {
  readonly kind: string;
  readonly provider: string;
  readonly categories: readonly string[];
}): Promise<readonly UsagePricingRow[]> {
  if (filter.categories.length === 0) {
    return [];
  }

  const db = fixtureDb();
  const where = and(
    eq(usagePricing.kind, filter.kind),
    eq(usagePricing.provider, filter.provider),
    inArray(usagePricing.category, [...filter.categories]),
  );
  const rows = await db
    .select({
      kind: usagePricing.kind,
      provider: usagePricing.provider,
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(where);
  await db.delete(usagePricing).where(where);
  return rows;
}
