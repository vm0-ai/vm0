import { sshConnectionObservationSchema } from "@okouai/api-contracts/contracts/ssh-connection-observations";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshConnectionObservations } from "@okouai/db/schema/ssh-connection-observation";
import { and, asc, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export async function listSshConnectionObservations(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
) {
  const rows = await db
    .select({
      connectionId: sshConnectionObservations.connectionId,
      generation: sshConnectionObservations.generation,
      observedAt: sshConnectionObservations.observedAt,
      failureReason: sshConnectionObservations.failureReason,
    })
    .from(sshConnections)
    .innerJoin(
      sshConnectionObservations,
      and(
        eq(sshConnectionObservations.connectionId, sshConnections.id),
        eq(sshConnectionObservations.generation, sshConnections.generation),
      ),
    )
    .where(
      and(eq(sshConnections.orgId, orgId), eq(sshConnections.userId, userId)),
    )
    .orderBy(asc(sshConnections.id));
  return rows.map((row) => {
    return sshConnectionObservationSchema.parse({
      ...row,
      observedAt: row.observedAt.toISOString(),
    });
  });
}
