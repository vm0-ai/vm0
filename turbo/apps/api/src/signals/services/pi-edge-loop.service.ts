import { command } from "ccstate";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import {
  materializeRunOutputEvents$,
  publishMaterializedChatProjection,
} from "./agent-event-consumer-run-output.service";
import {
  completeAgentRun$,
  dispatchCompleteSideEffects$,
} from "./agent-webhook-complete.service";
import type { PiEdgeModelConfig, PiEdgeTurnArgs } from "./pi-edge-config";
import { PI_MESSAGE_COMPLETED_EVENT_TYPE } from "./pi-transcript.service";

const L = logger("pi:edge");

const CHAT_COMPLETION_TIMEOUT_MS = 120_000;

interface PiContentBlock {
  readonly type: "text" | "thinking";
  readonly text: string;
}

interface PiMessagePayload {
  readonly role: "user" | "assistant";
  readonly content: readonly PiContentBlock[];
}

interface AssistantCompletion {
  readonly text: string;
  readonly thinking: string | null;
}

function chatCompletionsUrl(baseUrl: string): string {
  return new URL(
    "chat/completions",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

async function requestChatCompletion(
  config: PiEdgeModelConfig,
  systemPrompt: string,
  prompt: string,
  signal: AbortSignal,
): Promise<AssistantCompletion> {
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(CHAT_COMPLETION_TIMEOUT_MS),
  ]);
  const response = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      stream: false,
    }),
    signal: requestSignal,
  });
  if (!response.ok) {
    throw new Error(
      `Pi edge chat completion failed with status ${response.status}`,
    );
  }
  const payload: unknown = await response.json();
  const choices = recordOf(payload)?.choices;
  const choice = recordOf(Array.isArray(choices) ? choices[0] : null);
  const message = recordOf(choice?.message);
  const text = message?.content;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Pi edge chat completion returned no assistant text");
  }
  const thinking = message?.reasoning_content;
  return {
    text,
    thinking:
      typeof thinking === "string" && thinking.length > 0 ? thinking : null,
  };
}

function userMessagePayload(prompt: string): PiMessagePayload {
  return { role: "user", content: [{ type: "text", text: prompt }] };
}

function assistantMessagePayload(
  completion: AssistantCompletion,
): PiMessagePayload {
  return {
    role: "assistant",
    content: [
      ...(completion.thinking === null
        ? []
        : [{ type: "thinking" as const, text: completion.thinking }]),
      { type: "text" as const, text: completion.text },
    ],
  };
}

function piMessageEvent(
  runId: string,
  sequenceNumber: number,
  message: PiMessagePayload,
): AgentEvent {
  return {
    type: PI_MESSAGE_COMPLETED_EVENT_TYPE,
    sequenceNumber,
    messageId: `${runId}/${sequenceNumber}`,
    expectedVersion: 1,
    expectedLastOrdinal: sequenceNumber - 1,
    message,
  };
}

/**
 * Runs the v1a edge Pi turn for an eligible chat run: seeds the transcript
 * with the user message, performs a single non-streaming chat completion,
 * projects the assistant message through the same required projection as the
 * events webhook, and completes the run. The run must never strand: any
 * failure lands the failure completion instead.
 */
export const runPiEdgeTurn$ = command(
  async ({ set }, args: PiEdgeTurnArgs, signal: AbortSignal): Promise<void> => {
    const context = { userId: args.userId, orgId: args.orgId };
    let lastEventSequence: number | undefined;

    const project = async (event: AgentEvent): Promise<void> => {
      const payload: EventConsumerPayload = {
        runId: args.runId,
        events: [event],
        context,
      };
      const projection = await set(
        materializeRunOutputEvents$,
        payload,
        signal,
      );
      signal.throwIfAborted();
      if (projection) {
        await publishMaterializedChatProjection(payload, projection, signal);
        signal.throwIfAborted();
      }
      lastEventSequence = event.sequenceNumber;
    };

    const outcome = await settle(
      (async () => {
        await project(
          piMessageEvent(args.runId, 1, userMessagePayload(args.prompt)),
        );
        const completion = await requestChatCompletion(
          args.model,
          args.systemPrompt,
          args.prompt,
          signal,
        );
        signal.throwIfAborted();
        await project(
          piMessageEvent(args.runId, 2, assistantMessagePayload(completion)),
        );
      })(),
    );
    signal.throwIfAborted();
    let failure: string | undefined;
    if (!outcome.ok) {
      L.error("Pi edge turn failed", {
        runId: args.runId,
        error: outcome.error,
      });
      failure =
        outcome.error instanceof Error
          ? outcome.error.message
          : "Pi edge turn failed";
    }

    const result = await set(
      completeAgentRun$,
      {
        auth: { userId: args.userId, orgId: args.orgId, runId: args.runId },
        allowCheckpointlessSuccess: true,
        body: {
          runId: args.runId,
          exitCode: failure === undefined ? 0 : 1,
          ...(failure === undefined ? {} : { error: failure }),
          ...(lastEventSequence === undefined ? {} : { lastEventSequence }),
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.sideEffects) {
      await set(
        dispatchCompleteSideEffects$,
        { ...result.sideEffects, apiStartTime: args.apiStartTime },
        signal,
      );
    }
  },
);
