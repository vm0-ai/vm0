import { command, computed } from "ccstate";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { publishChatThreadDetailChangedSafely } from "../external/realtime";
import {
  clearChatThreadConnectorSelection,
  listChatThreadConnectorSelections,
  updateChatThreadConnectorSelection,
} from "../services/chat-thread-connector-selection.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const connectorAccountsEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await get(userFeatureSwitchContext(auth.orgId, auth.userId));
  return isFeatureEnabled(FeatureSwitchKey.ConnectorAccounts, context);
});

const getSelectionsInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await get(connectorAccountsEnabled$))) {
    return notFound("Resource not found");
  }
  const params = get(pathParamsOf(chatThreadConnectorSelectionContract.get));
  const result = await listChatThreadConnectorSelections(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    chatThreadId: params.id,
  });
  if (!result) {
    return notFound("Chat thread not found");
  }
  return {
    status: 200 as const,
    body: {
      selections: [...result.selections],
      selectedConnections: [...result.selectedConnections],
    },
  };
});

const updateSelectionInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await get(connectorAccountsEnabled$))) {
      return notFound("Resource not found");
    }
    const params = get(
      pathParamsOf(chatThreadConnectorSelectionContract.update),
    );
    const body = await get(
      bodyResultOf(chatThreadConnectorSelectionContract.update),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await updateChatThreadConnectorSelection(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      chatThreadId: params.id,
      selection: body.data,
    });
    signal.throwIfAborted();
    if (result.kind === "not_found") {
      return notFound("Chat thread not found");
    }
    if (result.kind === "invalid") {
      return badRequestMessage(result.message);
    }
    await publishChatThreadDetailChangedSafely(auth.userId, params.id);
    signal.throwIfAborted();
    return { status: 200 as const, body: result.selection };
  },
);

const clearSelectionInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await get(connectorAccountsEnabled$))) {
      return notFound("Resource not found");
    }
    const params = get(
      pathParamsOf(chatThreadConnectorSelectionContract.clear),
    );
    const body = await get(
      bodyResultOf(chatThreadConnectorSelectionContract.clear),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await clearChatThreadConnectorSelection(set(writeDb$), {
      orgId: auth.orgId,
      userId: auth.userId,
      chatThreadId: params.id,
      target: body.data,
    });
    signal.throwIfAborted();
    if (result.kind === "not_found") {
      return notFound("Chat thread not found");
    }
    await publishChatThreadDetailChangedSafely(auth.userId, params.id);
    signal.throwIfAborted();
    return { status: 204 as const, body: undefined };
  },
);

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-thread:read",
} as const;

const writeAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "chat-thread:write",
} as const;

export const chatThreadConnectorSelectionRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadConnectorSelectionContract.get,
    handler: authRoute(readAuth, getSelectionsInner$),
  },
  {
    route: chatThreadConnectorSelectionContract.update,
    handler: authRoute(writeAuth, updateSelectionInner$),
  },
  {
    route: chatThreadConnectorSelectionContract.clear,
    handler: authRoute(writeAuth, clearSelectionInner$),
  },
];
