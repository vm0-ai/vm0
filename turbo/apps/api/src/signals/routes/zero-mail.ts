import { command } from "ccstate";
import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import {
  publishChatThreadAutomationsChangedSafely,
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  deleteZeroMailDraft$,
  getZeroMailDraftAttachment$,
  getZeroMailDraft$,
  linkZeroMailDraft$,
  sendZeroMailDraft$,
  setupZeroMailFollowUp$,
  type ZeroMailDraftLinkMutationResult,
  type ZeroMailDraftMutationResult,
  type ZeroMailFollowUpSetupResult,
} from "../services/zero-mail.service";

const zeroMailReplyFollowUpDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Zero Mail reply follow-up is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

const zeroMailReplyFollowUpEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ZeroMailReplyFollowUp, context);
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

function linkMutationResponse(result: ZeroMailDraftLinkMutationResult) {
  switch (result.kind) {
    case "ok": {
      return {
        status: 200 as const,
        body: {
          mailDraftId: result.mailDraftId,
          mailDraftUrl: result.mailDraftUrl,
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

function followUpSetupResponse(result: ZeroMailFollowUpSetupResult) {
  switch (result.kind) {
    case "ok": {
      return {
        status: 200 as const,
        body: {
          mailDraftId: result.mailDraftId,
          automationId: result.automationId,
        },
      };
    }
    case "not_found": {
      return notFound(result.message);
    }
    case "conflict": {
      return conflict(result.message);
    }
    case "forbidden": {
      return forbidden(result.message);
    }
    case "bad_request": {
      return badRequestMessage(result.message);
    }
  }
}

const linkDraftBody$ = bodyResultOf(zeroMailContract.linkDraft);
const linkDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(linkDraftBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    linkZeroMailDraft$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...bodyResult.data,
    },
    signal,
  );
  return linkMutationResponse(result);
});

const getDraftParams$ = pathParamsOf(zeroMailContract.getDraft);
const getDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
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

const getAttachmentParams$ = pathParamsOf(zeroMailContract.getAttachment);

function attachmentResponseContentType(contentType: string): string {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (
    mediaType?.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType?.endsWith("+json")
  ) {
    return "application/octet-stream";
  }
  return contentType;
}

const getAttachmentInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      getZeroMailDraftAttachment$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...get(getAttachmentParams$),
      },
      signal,
    );
    switch (result.kind) {
      case "not_found": {
        return notFound(result.message);
      }
      case "conflict": {
        return conflict(result.message);
      }
      case "ok": {
        const headers = new Headers();
        headers.set(
          "Content-Type",
          attachmentResponseContentType(result.contentType),
        );
        headers.set("Content-Length", String(result.content.byteLength));
        headers.set("Cache-Control", "private, max-age=300");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        );
        const body = new Uint8Array(result.content.byteLength);
        body.set(result.content);
        return new Response(body, { status: 200, headers });
      }
    }
  },
);

const deleteDraftParams$ = pathParamsOf(zeroMailContract.deleteDraft);
const deleteDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
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

const sendDraftParams$ = pathParamsOf(zeroMailContract.sendDraft);
const sendDraftInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  return mutationResponse(
    await set(
      sendZeroMailDraft$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...get(sendDraftParams$),
      },
      signal,
    ),
  );
});

const createFollowUpBody$ = bodyResultOf(zeroMailContract.createFollowUp);
const createFollowUpParams$ = pathParamsOf(zeroMailContract.createFollowUp);
const createFollowUpInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await set(zeroMailReplyFollowUpEnabled$))) {
      return zeroMailReplyFollowUpDisabled;
    }
    signal.throwIfAborted();
    const bodyResult = await get(createFollowUpBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await set(
      setupZeroMailFollowUp$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        memberRole: auth.orgRole ?? "member",
        ...get(createFollowUpParams$),
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "ok") {
      await publishChatThreadAutomationsChangedSafely(
        auth.userId,
        result.chatThreadId,
      );
      signal.throwIfAborted();
      if (result.messageSeqId !== undefined) {
        await publishChatThreadMessageCreatedSafely(
          auth.userId,
          result.chatThreadId,
          result.messageSeqId,
        );
        signal.throwIfAborted();
        await publishThreadListChangedSafely(auth.userId);
        signal.throwIfAborted();
      }
    }
    return followUpSetupResponse(result);
  },
);

const mailDraftLinkAuth = Object.freeze({
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

const mailFollowUpHumanAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "agent:write" as const,
  accept: Object.freeze(["session"] as const),
});

export const zeroMailRoutes: readonly RouteEntry[] = [
  {
    route: zeroMailContract.linkDraft,
    handler: authRoute(mailDraftLinkAuth, linkDraftInner$),
  },
  {
    route: zeroMailContract.getDraft,
    handler: authRoute(mailDraftHumanAuth, getDraftInner$),
  },
  {
    route: zeroMailContract.getAttachment,
    handler: authRoute(mailDraftHumanAuth, getAttachmentInner$),
  },
  {
    route: zeroMailContract.deleteDraft,
    handler: authRoute(mailDraftHumanAuth, deleteDraftInner$),
  },
  {
    route: zeroMailContract.sendDraft,
    handler: authRoute(mailDraftHumanAuth, sendDraftInner$),
  },
  {
    route: zeroMailContract.createFollowUp,
    handler: authRoute(mailFollowUpHumanAuth, createFollowUpInner$),
  },
];
