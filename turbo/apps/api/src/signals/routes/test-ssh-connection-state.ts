import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { matchSshConnectionCredentials } from "../services/ssh-connection.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

type TestSshConnectionStateAction<
  TAction extends TestSshConnectionStateActionBody["action"],
> = Extract<TestSshConnectionStateActionBody, { action: TAction }>;

async function setLearnedHostKey(
  db: Db,
  body: TestSshConnectionStateAction<"set-learned-host-key">,
) {
  const [updated] = await db
    .update(sshConnections)
    .set({
      learnedHostKeyAlgorithm: body.algorithm,
      learnedHostKeyFingerprint: body.fingerprint,
      generation: sql`${sshConnections.generation} + 1`,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(sshConnections.id, body.connectionId),
        eq(sshConnections.orgId, body.orgId),
        eq(sshConnections.userId, body.userId),
      ),
    )
    .returning({ generation: sshConnections.generation });
  if (!updated) {
    return { status: 400 as const, body: { error: "Connection not found" } };
  }
  return {
    status: 200 as const,
    body: { ok: true as const, generation: updated.generation },
  };
}

async function matchCredentials(
  db: Db,
  body: TestSshConnectionStateAction<"match-credentials">,
) {
  const result = await matchSshConnectionCredentials({ db, ...body });
  if (!result) {
    return { status: 400 as const, body: { error: "Connection not found" } };
  }
  return {
    status: 200 as const,
    body: { ok: true as const, ...result },
  };
}

const mutateSshConnectionState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(
      bodyResultOf(testSshConnectionStateContract.action),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    switch (bodyResult.data.action) {
      case "set-learned-host-key": {
        return await setLearnedHostKey(db, bodyResult.data);
      }
      case "match-credentials": {
        return await matchCredentials(db, bodyResult.data);
      }
    }
  },
);

export const testSshConnectionStateRoutes: readonly RouteEntry[] = [
  {
    route: testSshConnectionStateContract.action,
    handler: mutateSshConnectionState$,
  },
];
