import { computed } from "ccstate";
import { zeroVoiceChatContract } from "@vm0/api-contracts/contracts/zero-voice-chat";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  serializeVoiceChatSession,
  voiceChatSessionList,
  voiceChatSessionDetail,
  voiceChatTaskList,
} from "../services/zero-voice-chat.service";

const voiceChatDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Voice-chat is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const listSessionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.Trinity, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
  if (!enabled) {
    return voiceChatDisabled;
  }
  const sessions = await get(voiceChatSessionList(auth.orgId, auth.userId));
  return {
    status: 200 as const,
    body: { sessions: sessions.map(serializeVoiceChatSession) },
  };
});

const getSessionInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroVoiceChatContract.getSession));
  const session = await get(
    voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
  );
  if (!session) {
    return notFound("Voice-chat session not found");
  }
  return {
    status: 200 as const,
    body: {
      session,
      recentTaskLogs: "",
      finishedTasksFullText: "",
      talkerInstructions: "",
      talkerInstructionTokens: 0,
    },
  };
});

const listTasksInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroVoiceChatContract.listTasks));

  // Verify the session exists and belongs to the user
  const session = await get(
    voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
  );
  if (!session) {
    return notFound("Voice-chat session not found");
  }

  const tasks = await get(voiceChatTaskList(params.id));
  return { status: 200 as const, body: { tasks } };
});

export const zeroVoiceChatRoutes: readonly RouteEntry[] = [
  {
    route: zeroVoiceChatContract.listSessions,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listSessionsInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.getSession,
    handler: shadowCompareRoute({
      route: zeroVoiceChatContract.getSession,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getSessionInner$,
      ),
    }),
  },
  {
    route: zeroVoiceChatContract.listTasks,
    handler: shadowCompareRoute({
      route: zeroVoiceChatContract.listTasks,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        listTasksInner$,
      ),
    }),
  },
];
