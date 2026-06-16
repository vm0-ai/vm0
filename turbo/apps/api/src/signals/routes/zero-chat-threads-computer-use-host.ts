import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { chatThreadComputerUseHostContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { computerUseHosts } from "@vm0/db/schema/computer-use-host";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../external/time";
import { notFound } from "../../lib/error";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import type { RouteEntry } from "../route";

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" } },
  };
}

async function computerUseFeatureEnabled(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
}): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    params.db,
    params.orgId,
    params.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ComputerUse, {
    orgId: params.orgId,
    userId: params.userId,
    overrides: context.overrides,
  });
}

async function threadExists(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
}): Promise<boolean> {
  const [thread] = await params.db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, params.threadId),
        eq(chatThreads.userId, params.userId),
      ),
    )
    .limit(1);
  return thread !== undefined;
}

async function computerUseHostExists(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
}): Promise<boolean> {
  const [host] = await params.db
    .select({ id: computerUseHosts.id })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.id, params.hostId),
        eq(computerUseHosts.orgId, params.orgId),
        eq(computerUseHosts.userId, params.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);
  return host !== undefined;
}

const computerUseHostBody$ = bodyResultOf(
  chatThreadComputerUseHostContract.update,
);

const updateComputerUseHostInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(chatThreadComputerUseHostContract.update));
    const body = await get(computerUseHostBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const db = set(writeDb$);
    if (
      !(await threadExists({
        db,
        threadId: params.id,
        userId: auth.userId,
      }))
    ) {
      return notFound("Chat thread not found");
    }
    signal.throwIfAborted();

    const hostId = body.data.computerUseHostId;
    if (hostId !== null) {
      if (
        !(await computerUseFeatureEnabled({
          db,
          orgId: auth.orgId,
          userId: auth.userId,
        }))
      ) {
        return forbidden("Computer use is not enabled");
      }
      signal.throwIfAborted();

      if (
        !(await computerUseHostExists({
          db,
          orgId: auth.orgId,
          userId: auth.userId,
          hostId,
        }))
      ) {
        return notFound("Computer-use host not found");
      }
      signal.throwIfAborted();
    }

    const updated = await db
      .update(chatThreads)
      .set({
        computerUseHostId: hostId,
        updatedAt: nowDate(),
      })
      .where(
        and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
      )
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();

    if (updated.length === 0) {
      return notFound("Chat thread not found");
    }

    await publishThreadListChanged(auth.userId);
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const zeroChatThreadComputerUseHostRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadComputerUseHostContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateComputerUseHostInner$,
    ),
  },
];
