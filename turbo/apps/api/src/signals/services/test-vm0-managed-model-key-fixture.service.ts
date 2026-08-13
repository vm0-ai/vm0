import { vm0ApiKeys } from "@okouai/db/schema/vm0-api-key";
import { eq, like } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { safeJsonParse } from "../utils";

const VM0_MANAGED_MODEL_KEY_FIXTURE_LABEL_KIND = "runtime-state-fixture";
const vm0ManagedModelKeyFixtureLabelSchema = z.object({
  kind: z.literal(VM0_MANAGED_MODEL_KEY_FIXTURE_LABEL_KIND),
  fixtureIds: z.array(z.string().uuid()).min(1),
  preservedLabel: z.string().nullable().optional(),
});

interface Vm0ManagedModelKeyRow {
  readonly vendor: string;
  readonly apiKey: string;
}

function vm0ManagedModelKeyFixtureLabel(
  fixtureIds: readonly string[],
  preservedLabel?: string | null,
): string {
  return JSON.stringify({
    kind: VM0_MANAGED_MODEL_KEY_FIXTURE_LABEL_KIND,
    fixtureIds,
    ...(preservedLabel === undefined ? {} : { preservedLabel }),
  });
}

function parseVm0ManagedModelKeyFixtureLabel(label: string | null) {
  if (!label) {
    return null;
  }
  const parsed = vm0ManagedModelKeyFixtureLabelSchema.safeParse(
    safeJsonParse(label),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Acquires fixture ownership of vendor-scoped VM0 keys.
 *
 * No product API provisions this platform-managed table. Test routes from
 * different integrations share each vendor row, so every owner must be
 * recorded under the same row lock before any fixture can release it.
 */
export async function acquireVm0ManagedModelKeyFixture(
  db: Db,
  fixtureId: string,
  rows: readonly Vm0ManagedModelKeyRow[],
): Promise<readonly Vm0ManagedModelKeyRow[]> {
  const acquiredRows: Vm0ManagedModelKeyRow[] = [];
  for (const value of rows) {
    const apiKey = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(vm0ApiKeys)
        .values({
          ...value,
          label: vm0ManagedModelKeyFixtureLabel([fixtureId]),
        })
        .onConflictDoUpdate({
          target: vm0ApiKeys.vendor,
          // Keep the existing key while atomically locking and returning its
          // vendor row. DO NOTHING followed by SELECT FOR UPDATE leaves a
          // window where the previous fixture owner can delete the row.
          set: { vendor: value.vendor },
        })
        .returning({
          id: vm0ApiKeys.id,
          apiKey: vm0ApiKeys.apiKey,
          label: vm0ApiKeys.label,
        });
      if (!row) {
        throw new Error(`Expected VM0 managed key for vendor: ${value.vendor}`);
      }

      const fixtureLabel = parseVm0ManagedModelKeyFixtureLabel(row.label);
      if (fixtureLabel?.fixtureIds.includes(fixtureId)) {
        return row.apiKey;
      }
      const fixtureIds = fixtureLabel
        ? [...fixtureLabel.fixtureIds, fixtureId]
        : [fixtureId];
      const preservedLabel = fixtureLabel
        ? fixtureLabel.preservedLabel
        : row.label === fixtureId
          ? undefined
          : row.label;
      await tx
        .update(vm0ApiKeys)
        .set({
          label: vm0ManagedModelKeyFixtureLabel(fixtureIds, preservedLabel),
          updatedAt: nowDate(),
        })
        .where(eq(vm0ApiKeys.id, row.id));
      return row.apiKey;
    });
    acquiredRows.push({ vendor: value.vendor, apiKey });
  }
  return acquiredRows;
}

/** Releases only one fixture's ownership, deleting the row at the last owner. */
export async function releaseVm0ManagedModelKeyFixture(
  db: Db,
  fixtureId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: vm0ApiKeys.id, label: vm0ApiKeys.label })
      .from(vm0ApiKeys)
      .where(like(vm0ApiKeys.label, `%${fixtureId}%`))
      .orderBy(vm0ApiKeys.vendor)
      .for("update");

    for (const row of rows) {
      const fixtureLabel = parseVm0ManagedModelKeyFixtureLabel(row.label);
      if (!fixtureLabel?.fixtureIds.includes(fixtureId)) {
        continue;
      }
      const remainingFixtureIds = fixtureLabel.fixtureIds.filter((id) => {
        return id !== fixtureId;
      });
      if (remainingFixtureIds.length > 0) {
        await tx
          .update(vm0ApiKeys)
          .set({
            label: vm0ManagedModelKeyFixtureLabel(
              remainingFixtureIds,
              fixtureLabel.preservedLabel,
            ),
            updatedAt: nowDate(),
          })
          .where(eq(vm0ApiKeys.id, row.id));
        continue;
      }
      if (fixtureLabel.preservedLabel !== undefined) {
        await tx
          .update(vm0ApiKeys)
          .set({
            label: fixtureLabel.preservedLabel,
            updatedAt: nowDate(),
          })
          .where(eq(vm0ApiKeys.id, row.id));
        continue;
      }
      await tx.delete(vm0ApiKeys).where(eq(vm0ApiKeys.id, row.id));
    }
  });
}
