import { command } from "ccstate";
import {
  testChatMessagesStateContract,
  VM0_BDD_API_KEY_PREFIXES,
  type TestChatMessagesStateActionBody,
} from "@vm0/api-contracts/contracts/test-chat-messages-state";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { secrets } from "@vm0/db/schema/secret";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, like, or } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { BEFORE_DISPATCH_CANCELLED_ERROR } from "../services/agent-run-create.service";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testChatMessagesStateContract.action);
const ORG_SENTINEL_USER_ID = "__org__";

type ChatMessagesAction<
  TAction extends TestChatMessagesStateActionBody["action"],
> = Extract<TestChatMessagesStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function bddVm0ApiKeyFilter(vendor: string, model: string) {
  const [fakePrefix, devSeedPrefix] = VM0_BDD_API_KEY_PREFIXES;
  return and(
    eq(vm0ApiKeys.vendor, vendor),
    eq(vm0ApiKeys.model, model),
    or(
      like(vm0ApiKeys.apiKey, `${fakePrefix}%`),
      like(vm0ApiKeys.apiKey, `${devSeedPrefix}%`),
    ),
  );
}

async function overwriteOrgModelProviderSecretForAction(
  db: Db,
  body: ChatMessagesAction<"overwrite-org-model-provider-secret">,
  signal: AbortSignal,
) {
  const encryptedValue = await encryptPersistentSecretValue(body.value, {
    orgId: body.org_id,
    userId: ORG_SENTINEL_USER_ID,
  });
  signal.throwIfAborted();
  await db
    .update(secrets)
    .set({ encryptedValue })
    .where(
      and(
        eq(secrets.orgId, body.org_id),
        eq(secrets.userId, ORG_SENTINEL_USER_ID),
        eq(secrets.name, body.name),
        eq(secrets.type, "model-provider"),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function readThreadComputerUseHostIdForAction(
  db: Db,
  body: ChatMessagesAction<"read-thread-computer-use-host-id">,
  signal: AbortSignal,
) {
  const [thread] = await db
    .select({ computerUseHostId: chatThreads.computerUseHostId })
    .from(chatThreads)
    .where(eq(chatThreads.id, body.thread_id))
    .limit(1);
  signal.throwIfAborted();
  if (!thread) {
    return {
      status: 400 as const,
      body: { error: "Expected chat thread to exist" },
    };
  }
  return actionOk({ computer_use_host_id: thread.computerUseHostId });
}

async function replaceOpenRouterVm0ApiKeysForAction(
  db: Db,
  body: ChatMessagesAction<"replace-openrouter-vm0-api-keys">,
  signal: AbortSignal,
) {
  return await replaceVm0ApiKeysForAction(
    db,
    {
      action: "replace-vm0-api-keys",
      vendor: "openrouter",
      model: body.model,
      keys: body.keys,
    },
    signal,
  );
}

async function replaceVm0ApiKeysForAction(
  db: Db,
  body: ChatMessagesAction<"replace-vm0-api-keys">,
  signal: AbortSignal,
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(vm0ApiKeys)
      .where(bddVm0ApiKeyFilter(body.vendor, body.model));
    signal.throwIfAborted();
    if (body.keys.length > 0) {
      await tx.insert(vm0ApiKeys).values(
        body.keys.map((key) => {
          return {
            vendor: body.vendor,
            model: body.model,
            apiKey: key.api_key,
            label: key.label,
          };
        }),
      );
      signal.throwIfAborted();
    }
  });
  return actionOk();
}

async function deleteOpenRouterVm0ApiKeysForAction(
  db: Db,
  body: ChatMessagesAction<"delete-openrouter-vm0-api-keys">,
  signal: AbortSignal,
) {
  return await deleteVm0ApiKeysForAction(
    db,
    {
      action: "delete-vm0-api-keys",
      vendor: "openrouter",
      model: body.model,
    },
    signal,
  );
}

async function deleteVm0ApiKeysForAction(
  db: Db,
  body: ChatMessagesAction<"delete-vm0-api-keys">,
  signal: AbortSignal,
) {
  await db
    .delete(vm0ApiKeys)
    .where(bddVm0ApiKeyFilter(body.vendor, body.model));
  signal.throwIfAborted();
  return actionOk();
}

async function attachPreDispatchCancelledRunToThreadForAction(
  db: Db,
  body: ChatMessagesAction<"attach-pre-dispatch-cancelled-run-to-thread">,
  signal: AbortSignal,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(agentRuns)
      .set({
        status: "cancelled",
        completedAt: nowDate(),
        error: BEFORE_DISPATCH_CANCELLED_ERROR,
      })
      .where(eq(agentRuns.id, body.run_id));
    await tx
      .update(zeroRuns)
      .set({ chatThreadId: body.thread_id })
      .where(eq(zeroRuns.id, body.run_id));
  });
  signal.throwIfAborted();
  return actionOk();
}

const mutateChatMessagesState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "overwrite-org-model-provider-secret": {
        return await overwriteOrgModelProviderSecretForAction(db, body, signal);
      }
      case "read-thread-computer-use-host-id": {
        return await readThreadComputerUseHostIdForAction(db, body, signal);
      }
      case "replace-openrouter-vm0-api-keys": {
        return await replaceOpenRouterVm0ApiKeysForAction(db, body, signal);
      }
      case "delete-openrouter-vm0-api-keys": {
        return await deleteOpenRouterVm0ApiKeysForAction(db, body, signal);
      }
      case "replace-vm0-api-keys": {
        return await replaceVm0ApiKeysForAction(db, body, signal);
      }
      case "delete-vm0-api-keys": {
        return await deleteVm0ApiKeysForAction(db, body, signal);
      }
      case "attach-pre-dispatch-cancelled-run-to-thread": {
        return await attachPreDispatchCancelledRunToThreadForAction(
          db,
          body,
          signal,
        );
      }
    }
  },
);

export const testChatMessagesStateRoutes: readonly RouteEntry[] = [
  {
    route: testChatMessagesStateContract.action,
    handler: mutateChatMessagesState$,
  },
];
