import { computed } from "ccstate";
import { zeroVoiceChatContract } from "@vm0/api-contracts/contracts/zero-voice-chat";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { shadowCompareRoute } from "../context/shadow-compare";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";
import {
  voiceChatSessionList,
  voiceChatSessionDetail,
  voiceChatTaskList,
} from "../services/zero-voice-chat.service";

const listSessionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const sessions = await get(voiceChatSessionList(auth.orgId, auth.userId));
  return { status: 200 as const, body: { sessions } };
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
    handler: shadowCompareRoute({
      route: zeroVoiceChatContract.listSessions,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        listSessionsInner$,
      ),
    }),
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
