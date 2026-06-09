import { command, computed } from "ccstate";
import {
  webhookAutomationsByIdContract,
  webhookAutomationsMainContract,
  type WebhookAutomationResponse,
} from "@vm0/api-contracts/contracts/webhook-automations";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  createWebhookAutomation$,
  deleteWebhookAutomation$,
  listWebhookAutomations$,
  type WebhookAutomationView,
} from "../services/webhook-automations.service";
import type { RouteEntry } from "../route";

function toResponse(view: WebhookAutomationView): WebhookAutomationResponse {
  return view;
}

// Webhook automations share the time-automation gate: when the zeroAutomations
// switch is off the surface is unreachable, so handlers report not-found and the
// new paths are indistinguishable from unmounted routes.
const automationsEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.ZeroAutomations, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(webhookAutomationsMainContract.create),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    createWebhookAutomation$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      body: bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound(result.message);
  }
  if (result.kind === "bad_request") {
    return badRequestMessage(result.message);
  }
  return {
    status: 201 as const,
    body: {
      automation: toResponse(result.automation),
      secret: result.secret,
    },
  };
});

const listInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const automations = await set(
    listWebhookAutomations$,
    { userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { automations: automations.map(toResponse) },
  };
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(automationsEnabled$))) {
    return notFound("Resource not found");
  }
  signal.throwIfAborted();
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(webhookAutomationsByIdContract.delete));

  const result = await set(
    deleteWebhookAutomation$,
    { userId: auth.userId, orgId: auth.orgId, id: params.id },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return notFound("Resource not found");
  }
  return { status: 204 as const, body: undefined };
});

export const webhookAutomationsRoutes: readonly RouteEntry[] = [
  {
    route: webhookAutomationsMainContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:write",
      },
      createInner$,
    ),
  },
  {
    route: webhookAutomationsMainContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:read",
      },
      listInner$,
    ),
  },
  {
    route: webhookAutomationsByIdContract.delete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "schedule:delete",
      },
      deleteInner$,
    ),
  },
];
