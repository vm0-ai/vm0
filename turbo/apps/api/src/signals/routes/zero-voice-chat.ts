import { command, computed, type Computed } from "ccstate";
import { zeroVoiceChatContract } from "@vm0/api-contracts/contracts/zero-voice-chat";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { waitUntil } from "../context/wait-until";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { badRequestMessage, notFound } from "../../lib/error";
import { now } from "../external/time";
import { publishUserSignal } from "../external/realtime";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { voiceChatTalkerPayload } from "../services/voice-chat-talker.service";
import {
  appendVoiceChatItem$,
  checkVoiceChatCredits$,
  createVoiceChatRealtimeSession$,
  createVoiceChatEphemeralToken$,
  createVoiceChatSession$,
  createVoiceChatTask$,
  endVoiceChatRealtimeSession$,
  recordVoiceChatRealtimeUsage$,
  serializeVoiceChatSession,
  serializeVoiceChatItem,
  serializeVoiceChatTask,
  triggerVoiceChatReasoning$,
  voiceChatRealtimePricingGate$,
  voiceChatTaskAppendSystemPrompt,
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

function voiceChatGates(auth: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<
  Promise<{
    readonly voiceChatEnabled: boolean;
    readonly realtimeBillingEnabled: boolean;
  }>
> {
  return computed(async (get) => {
    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    const evalKey = (key: FeatureSwitchKey) => {
      return isFeatureEnabled(key, {
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      });
    };
    return {
      voiceChatEnabled: evalKey(FeatureSwitchKey.Trinity),
      realtimeBillingEnabled: evalKey(
        FeatureSwitchKey.VoiceChatRealtimeBilling,
      ),
    };
  });
}

function voiceChatEnabled(auth: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<boolean>> {
  return computed(async (get) => {
    return (await get(voiceChatGates(auth))).voiceChatEnabled;
  });
}

const listSessionsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const enabled = await get(voiceChatEnabled(auth));
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
  const enabled = await get(voiceChatEnabled(auth));
  if (!enabled) {
    // Web pattern: collapse flag-disabled into 404 to avoid leaking
    // session existence (contract does not declare 403 for getSession).
    return notFound("Voice-chat session not found");
  }
  const params = get(pathParamsOf(zeroVoiceChatContract.getSession));
  const session = await get(
    voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
  );
  if (!session) {
    return notFound("Voice-chat session not found");
  }
  const talker = await get(voiceChatTalkerPayload(session));
  return {
    status: 200 as const,
    body: {
      session: serializeVoiceChatSession(session),
      ...talker,
    },
  };
});

const listTasksInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const enabled = await get(voiceChatEnabled(auth));
  if (!enabled) {
    // Web pattern: collapse flag-disabled into 404 to avoid leaking
    // session existence (contract does not declare 403 for listTasks).
    return notFound("Voice-chat session not found");
  }
  const params = get(pathParamsOf(zeroVoiceChatContract.listTasks));
  const session = await get(
    voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
  );
  if (!session) {
    return notFound("Voice-chat session not found");
  }
  const tasks = await get(voiceChatTaskList(params.id));
  return {
    status: 200 as const,
    body: { tasks: tasks.map(serializeVoiceChatTask) },
  };
});

const createSessionBody$ = bodyResultOf(zeroVoiceChatContract.createSession);

const createSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const enabled = await get(voiceChatEnabled(auth));
    signal.throwIfAborted();
    if (!enabled) {
      return voiceChatDisabled;
    }

    const body = await get(createSessionBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const session = await set(
      createVoiceChatSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: body.data.agentId,
      },
      signal,
    );
    signal.throwIfAborted();
    const talker = await get(voiceChatTalkerPayload(session));
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { session: serializeVoiceChatSession(session), ...talker },
    };
  },
);

const appendItemBody$ = bodyResultOf(zeroVoiceChatContract.appendItem);

const appendItemInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await get(voiceChatEnabled(auth));
  signal.throwIfAborted();
  if (!enabled) {
    return notFound("Voice-chat session not found");
  }

  const params = get(pathParamsOf(zeroVoiceChatContract.appendItem));
  const session = await get(
    voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
  );
  signal.throwIfAborted();
  if (!session) {
    return notFound("Voice-chat session not found");
  }

  const body = await get(appendItemBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await set(
    appendVoiceChatItem$,
    {
      sessionId: params.id,
      role: body.data.role,
      content: body.data.content,
      realtimeItemId: body.data.realtimeItemId,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in result) {
    return result;
  }
  if (result.inserted) {
    waitUntil(set(triggerVoiceChatReasoning$, params.id, signal));
  }
  return {
    status: 200 as const,
    body: { item: serializeVoiceChatItem(result.item) },
  };
});

const createTaskBody$ = bodyResultOf(zeroVoiceChatContract.createTask);

const createTaskInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await get(voiceChatEnabled(auth));
  signal.throwIfAborted();
  if (!enabled) {
    return notFound("Voice-chat session not found");
  }

  const params = get(pathParamsOf(zeroVoiceChatContract.createTask));
  const session = await get(
    voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
  );
  signal.throwIfAborted();
  if (!session) {
    return notFound("Voice-chat session not found");
  }
  if (!session.agentId) {
    return badRequestMessage("Session has no agent; cannot spawn task");
  }

  const body = await get(createTaskBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const appendSystemPrompt = await get(
    voiceChatTaskAppendSystemPrompt(params.id, session.agentId),
  );
  signal.throwIfAborted();

  const created = await set(
    createVoiceChatTask$,
    {
      sessionId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: session.agentId,
      callId: body.data.callId,
      prompt: body.data.prompt,
      appendSystemPrompt,
      apiStartTime: now(),
    },
    signal,
  );
  signal.throwIfAborted();
  if (created.status !== 200) {
    return created;
  }

  await publishUserSignal([session.userId], `voice-chat:${params.id}`);
  signal.throwIfAborted();
  waitUntil(set(triggerVoiceChatReasoning$, params.id, signal));

  return {
    status: 200 as const,
    body: { task: serializeVoiceChatTask(created.task) },
  };
});

const triggerReasoningInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const enabled = await get(voiceChatEnabled(auth));
    signal.throwIfAborted();
    if (!enabled) {
      return notFound("Session not found or not active");
    }

    const params = get(pathParamsOf(zeroVoiceChatContract.triggerReasoning));
    const session = await get(
      voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
    );
    signal.throwIfAborted();
    if (!session) {
      return notFound("Session not found");
    }

    waitUntil(set(triggerVoiceChatReasoning$, params.id, signal));
    return { status: 200 as const, body: { ok: true as const } };
  },
);

const tokenBody$ = bodyResultOf(zeroVoiceChatContract.token);

const tokenInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const gates = await get(voiceChatGates(auth));
  signal.throwIfAborted();
  if (!gates.voiceChatEnabled) {
    return voiceChatDisabled;
  }

  const body = await get(tokenBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const session = await get(
    voiceChatSessionDetail(auth.orgId, auth.userId, body.data.sessionId),
  );
  signal.throwIfAborted();
  if (!session) {
    return notFound("Voice-chat session not found");
  }

  if (gates.realtimeBillingEnabled) {
    const credits = await set(
      checkVoiceChatCredits$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();
    if (credits) {
      return credits;
    }
    const pricing = await get(voiceChatRealtimePricingGate$);
    signal.throwIfAborted();
    if (pricing) {
      return pricing;
    }
  }

  const { talkerInstructions } = await get(voiceChatTalkerPayload(session));
  signal.throwIfAborted();
  return await set(
    createVoiceChatEphemeralToken$,
    {
      userId: auth.userId,
      instructions: talkerInstructions,
      noiseReduction: body.data.noiseReduction,
    },
    signal,
  );
});

const postUsageEventBody$ = bodyResultOf(zeroVoiceChatContract.postUsageEvent);

const postUsageEventInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const gates = await get(voiceChatGates(auth));
    signal.throwIfAborted();
    if (!gates.voiceChatEnabled) {
      return notFound("Voice-chat session not found");
    }
    if (!gates.realtimeBillingEnabled) {
      return { status: 200 as const, body: { creditsExhausted: false } };
    }

    const body = await get(postUsageEventBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    if (
      body.data.eventType === "transcription.completed" &&
      body.data.outputAudioTokens !== undefined
    ) {
      return badRequestMessage(
        "transcription.completed cannot include outputAudioTokens",
      );
    }

    const params = get(pathParamsOf(zeroVoiceChatContract.postUsageEvent));
    const session = await get(
      voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
    );
    signal.throwIfAborted();
    if (!session) {
      return notFound("Voice-chat session not found");
    }

    const result = await set(
      recordVoiceChatRealtimeUsage$,
      {
        voiceChatSessionId: params.id,
        orgId: session.orgId,
        userId: session.userId,
        providerEventId: body.data.providerEventId,
        eventType: body.data.eventType,
        tokens: {
          inputText: body.data.inputTextTokens,
          inputAudio: body.data.inputAudioTokens,
          inputCachedText: body.data.inputCachedTextTokens,
          inputCachedAudio: body.data.inputCachedAudioTokens,
          outputText: body.data.outputTextTokens,
          outputAudio: body.data.outputAudioTokens,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { creditsExhausted: result.creditsExhausted },
    };
  },
);

const sessionStartedInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const gates = await get(voiceChatGates(auth));
    signal.throwIfAborted();
    if (!gates.voiceChatEnabled) {
      return notFound("Voice-chat session not found");
    }
    if (!gates.realtimeBillingEnabled) {
      return { status: 200 as const, body: { id: null } };
    }

    const params = get(pathParamsOf(zeroVoiceChatContract.sessionStarted));
    const session = await get(
      voiceChatSessionDetail(auth.orgId, auth.userId, params.id),
    );
    signal.throwIfAborted();
    if (!session) {
      return notFound("Voice-chat session not found");
    }

    const id = await set(
      createVoiceChatRealtimeSession$,
      {
        voiceChatSessionId: params.id,
        orgId: session.orgId,
        userId: session.userId,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body: { id } };
  },
);

const sessionEndedBody$ = bodyResultOf(zeroVoiceChatContract.sessionEnded);

const sessionEndedInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(sessionEndedBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const params = get(pathParamsOf(zeroVoiceChatContract.sessionEnded));
    const ended = await set(
      endVoiceChatRealtimeSession$,
      {
        voiceChatSessionId: params.id,
        orgId: auth.orgId,
        userId: auth.userId,
        realtimeSessionId: body.data.relaySessionId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!ended) {
      return notFound("Voice-chat realtime session not found");
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const zeroVoiceChatRoutes: readonly RouteEntry[] = [
  {
    route: zeroVoiceChatContract.createSession,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      createSessionInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.listSessions,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listSessionsInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.getSession,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getSessionInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.appendItem,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      appendItemInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.createTask,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      createTaskInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.listTasks,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listTasksInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.triggerReasoning,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      triggerReasoningInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.token,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      tokenInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.postUsageEvent,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      postUsageEventInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.sessionStarted,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      sessionStartedInner$,
    ),
  },
  {
    route: zeroVoiceChatContract.sessionEnded,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      sessionEndedInner$,
    ),
  },
];
