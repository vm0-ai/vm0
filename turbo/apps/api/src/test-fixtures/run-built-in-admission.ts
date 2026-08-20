import { runBuiltInAdmissions } from "@okouai/db/schema/run-built-in-admission";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

export async function insertActiveRunBuiltInAdmissionFixture(
  runId: string,
): Promise<string> {
  const now = nowDate();
  const [admission] = await db()
    .insert(runBuiltInAdmissions)
    .values({
      runId,
      kind: "image",
      status: "active",
      expiresAt: new Date(now.getTime() + 60_000),
    })
    .returning({ id: runBuiltInAdmissions.id });
  if (!admission) {
    throw new Error("Expected an active built-in admission to be inserted");
  }
  return admission.id;
}

export async function completeRunBuiltInAdmissionFixture(
  admissionId: string,
): Promise<void> {
  const now = nowDate();
  await db()
    .update(runBuiltInAdmissions)
    .set({ status: "completed", completedAt: now, updatedAt: now })
    .where(eq(runBuiltInAdmissions.id, admissionId));
}
