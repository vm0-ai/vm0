import { command } from "ccstate";
import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  createZeroMailDraft$,
  deleteZeroMailDraft$,
  getZeroMailDraft$,
  sendZeroMailDraft$,
  updateZeroMailDraft$,
  type ZeroMailDraftMutationResult,
} from "../services/zero-mail.service";

const zeroMailDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Zero Mail is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const zeroMailEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ZeroMail, context);
});

function mutationResponse(result: ZeroMailDraftMutationResult) {
  switch (result.kind) {
    case "ok": {
      return {
        status: 200 as const,
        body: {
          mailDraftId: result.mailDraftId,
          mailDraftUrl: result.mailDraftUrl,
          mailDraft: result.mailDraft,
        },
      };
    }
    case "not_found": {
      return notFound(result.message);
    }
    case "conflict": {
      return conflict(result.message);
    }
  }
}

const createDraftBody$ = bodyResultOf(zeroMailContract.createDraft);
const createDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroMailEnabled$))) {
    return zeroMailDisabled;
  }
  signal.throwIfAborted();
  const bodyResult = await get(createDraftBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    createZeroMailDraft$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    },
    signal,
  );
  if (result.kind !== "ok") {
    return mutationResponse(result);
  }
  return {
    status: 201 as const,
    body: {
      mailDraftId: result.mailDraftId,
      mailDraftUrl: result.mailDraftUrl,
      mailDraft: result.mailDraft,
    },
  };
});

const getDraftParams$ = pathParamsOf(zeroMailContract.getDraft);
const getDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroMailEnabled$))) {
    return zeroMailDisabled;
  }
  return mutationResponse(
    await set(
      getZeroMailDraft$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...get(getDraftParams$),
      },
      signal,
    ),
  );
});

const updateDraftBody$ = bodyResultOf(zeroMailContract.updateDraft);
const updateDraftParams$ = pathParamsOf(zeroMailContract.updateDraft);
const updateDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroMailEnabled$))) {
    return zeroMailDisabled;
  }
  signal.throwIfAborted();
  const bodyResult = await get(updateDraftBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return mutationResponse(
    await set(
      updateZeroMailDraft$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...get(updateDraftParams$),
        ...bodyResult.data,
      },
      signal,
    ),
  );
});

const deleteDraftParams$ = pathParamsOf(zeroMailContract.deleteDraft);
const deleteDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroMailEnabled$))) {
    return zeroMailDisabled;
  }
  const result = await set(
    deleteZeroMailDraft$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...get(deleteDraftParams$),
    },
    signal,
  );
  if (result.kind !== "ok") {
    return mutationResponse(result);
  }
  return { status: 204 as const, body: undefined };
});

const cancelDraftParams$ = pathParamsOf(zeroMailContract.cancelDraft);
const cancelDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroMailEnabled$))) {
    return zeroMailDisabled;
  }
  return mutationResponse(
    await set(
      deleteZeroMailDraft$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...get(cancelDraftParams$),
      },
      signal,
    ),
  );
});

const sendDraftBody$ = bodyResultOf(zeroMailContract.sendDraft);
const sendDraftParams$ = pathParamsOf(zeroMailContract.sendDraft);
const sendDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroMailEnabled$))) {
    return zeroMailDisabled;
  }
  signal.throwIfAborted();
  const bodyResult = await get(sendDraftBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return mutationResponse(
    await set(
      sendZeroMailDraft$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...get(sendDraftParams$),
        ...bodyResult.data,
      },
      signal,
    ),
  );
});

const mailDraftCreateAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "connector:read" as const,
  accept: Object.freeze(["session", "zero"] as const),
});

const mailDraftHumanAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "connector:read" as const,
  accept: Object.freeze(["session"] as const),
});

export const zeroMailRoutes: readonly RouteEntry[] = [
  {
    route: zeroMailContract.createDraft,
    handler: authRoute(mailDraftCreateAuth, createDraftInner$),
  },
  {
    route: zeroMailContract.getDraft,
    handler: authRoute(mailDraftHumanAuth, getDraftInner$),
  },
  {
    route: zeroMailContract.updateDraft,
    handler: authRoute(mailDraftHumanAuth, updateDraftInner$),
  },
  {
    route: zeroMailContract.deleteDraft,
    handler: authRoute(mailDraftHumanAuth, deleteDraftInner$),
  },
  {
    route: zeroMailContract.cancelDraft,
    handler: authRoute(mailDraftHumanAuth, cancelDraftInner$),
  },
  {
    route: zeroMailContract.sendDraft,
    handler: authRoute(mailDraftHumanAuth, sendDraftInner$),
  },
];
