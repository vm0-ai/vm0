import { computed } from "ccstate";
import { initContract } from "@ts-rest/core";
import { z } from "zod";
import {
  voiceChatSessionSchema,
  voiceChatTaskSchema,
} from "@vm0/api-contracts/contracts/zero-voice-chat";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";
import {
  voiceChatCandidateSessionList,
  voiceChatCandidateSessionDetail,
  voiceChatCandidateTaskList,
} from "../services/zero-voice-chat.service";

const c = initContract();

const voiceChatCandidateContract = c.router({
  listSessions: {
    method: "GET",
    path: "/api/zero/voice-chat-candidate",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ sessions: z.array(voiceChatSessionSchema) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List voice-chat-candidate sessions for the current user",
  },

  getSession: {
    method: "GET",
    path: "/api/zero/voice-chat-candidate/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: z.object({
        session: voiceChatSessionSchema,
        recentTaskLogs: z.string(),
        finishedTasksFullText: z.string(),
        talkerInstructions: z.string(),
        talkerInstructionTokens: z.number().int().nonnegative(),
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a voice-chat-candidate session with recent task logs",
  },

  listTasks: {
    method: "GET",
    path: "/api/zero/voice-chat-candidate/:id/tasks",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: z.object({ tasks: z.array(voiceChatTaskSchema) }),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List active + recently-finished tasks for a candidate session",
  },
});

const listSessionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const sessions = await get(
    voiceChatCandidateSessionList(auth.orgId, auth.userId),
  );
  return { status: 200 as const, body: { sessions } };
});

const getSessionInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(voiceChatCandidateContract.getSession));
  const session = await get(
    voiceChatCandidateSessionDetail(auth.orgId, auth.userId, params.id),
  );
  if (!session) {
    return notFound("Voice-chat-candidate session not found");
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
  const params = get(pathParamsOf(voiceChatCandidateContract.listTasks));

  // Verify the session exists and belongs to the user
  const session = await get(
    voiceChatCandidateSessionDetail(auth.orgId, auth.userId, params.id),
  );
  if (!session) {
    return notFound("Voice-chat-candidate session not found");
  }

  const tasks = await get(voiceChatCandidateTaskList(params.id));
  return { status: 200 as const, body: { tasks } };
});

export const zeroVoiceChatCandidateRoutes: readonly RouteEntry[] = [
  {
    route: voiceChatCandidateContract.listSessions,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listSessionsInner$,
    ),
  },
  {
    route: voiceChatCandidateContract.getSession,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getSessionInner$,
    ),
  },
  {
    route: voiceChatCandidateContract.listTasks,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listTasksInner$,
    ),
  },
];
