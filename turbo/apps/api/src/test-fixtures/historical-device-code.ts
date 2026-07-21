import { deviceCodes } from "@vm0/db/schema/device-codes";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

interface HistoricalDeviceCodeFixture {
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * Seeds a code written by the retired BB0 API. Current production APIs cannot
 * construct this rollout state, so this is a narrow test-boundary exception.
 */
export async function seedHistoricalBb0DeviceCode(
  fixture: HistoricalDeviceCodeFixture,
): Promise<void> {
  const timestamp = nowDate();
  await db().insert(deviceCodes).values({
    code: fixture.code,
    purpose: "bb0",
    status: "pending",
    expiresAt: fixture.expiresAt,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

/** Deletes only the historical BB0 device code seeded above. */
export async function deleteHistoricalBb0DeviceCode(
  code: string,
): Promise<void> {
  await db()
    .delete(deviceCodes)
    .where(and(eq(deviceCodes.code, code), eq(deviceCodes.purpose, "bb0")));
}
