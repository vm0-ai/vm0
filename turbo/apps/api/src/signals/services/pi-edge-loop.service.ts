import { command } from "ccstate";
import {
  MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  parsePiAgentMessages,
  piMessageRequiresSandbox,
  runPiAgentPrompt,
  type PiAgentMessage,
} from "@vm0/pi-agent-runtime";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { publishPiStandbyReleaseToRunnerGroupSafely } from "../external/realtime";
import { settle } from "../utils";
import { ingestAxiomEvents } from "./agent-event-consumer-axiom.service";
import {
  materializeRunOutputEvents$,
  publishMaterializedChatProjection,
  type PiEdgeModelUsage,
  type PiEdgeModelUsageEntry,
} from "./agent-event-consumer-run-output.service";
import {
  completeAgentRun$,
  dispatchCompleteSideEffects$,
  dispatchPiSandboxHandoff,
} from "./agent-webhook-complete.service";
import type { PiEdgeTurnArgs } from "./pi-edge-config";
import {
  PI_MESSAGE_COMPLETED_EVENT_TYPE,
  readPiTranscript,
} from "./pi-transcript.service";
import { chatThreadForRunFromDb } from "./zero-chat-thread.service";

const L = logger("pi:edge");

class PiHandoffRequested extends Error {}

interface PiEdgeUsageQuantities {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

function modelUsageQuantity(value: number, category: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi edge model returned invalid ${category} usage`);
  }
  return value;
}

function piEdgeBillingEntries(
  model: SupportedRunModel,
  quantities: PiEdgeUsageQuantities,
): PiEdgeModelUsageEntry[] {
  const totalInput =
    quantities.input + quantities.cacheRead + quantities.cacheCreation;
  const longContextMinimum = MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[model];
  const tier =
    longContextMinimum !== undefined && totalInput >= longContextMinimum
      ? "long-context"
      : "base";
  const categories: Readonly<
    Record<
      "input" | "output" | "cacheRead" | "cacheCreation",
      PiEdgeModelUsageEntry["category"]
    >
  > =
    tier === "long-context"
      ? {
          input: "tokens.input.long_context",
          output: "tokens.output.long_context",
          cacheRead: "tokens.cache_read.long_context",
          cacheCreation: "tokens.cache_creation.long_context",
        }
      : {
          input: "tokens.input",
          output: "tokens.output",
          cacheRead: "tokens.cache_read",
          cacheCreation: "tokens.cache_creation",
        };
  const entries: PiEdgeModelUsageEntry[] = [
    { category: categories.input, quantity: quantities.input },
    { category: categories.output, quantity: quantities.output },
    {
      category: categories.cacheRead,
      quantity: quantities.cacheRead,
    },
    {
      category: categories.cacheCreation,
      quantity: quantities.cacheCreation,
    },
  ].filter((entry) => {
    return entry.quantity > 0;
  });
  return entries;
}

function piEdgeModelUsage(args: {
  readonly messageId: string;
  readonly usage: PiEdgeTurnArgs["usage"];
  readonly message: PiAgentMessage;
}): PiEdgeModelUsage | undefined {
  if (args.usage === undefined || args.message.role !== "assistant") {
    return undefined;
  }

  const quantities: PiEdgeUsageQuantities = {
    input: modelUsageQuantity(args.message.usage.input, "input"),
    output: modelUsageQuantity(args.message.usage.output, "output"),
    cacheRead: modelUsageQuantity(args.message.usage.cacheRead, "cache read"),
    cacheCreation: modelUsageQuantity(
      args.message.usage.cacheWrite,
      "cache creation",
    ),
  };
  const hasPositiveUsage = Object.values(quantities).some((quantity) => {
    return quantity > 0;
  });
  if (!hasPositiveUsage) {
    const failed =
      args.message.stopReason === "error" ||
      args.message.stopReason === "aborted";
    if (args.usage.billable && !failed) {
      throw new Error("Pi edge model returned no billable usage");
    }
    return undefined;
  }

  return {
    messageId: args.messageId,
    model: args.usage.model,
    inputTokens: quantities.input,
    outputTokens: quantities.output,
    cacheReadInputTokens: quantities.cacheRead,
    cacheCreationInputTokens: quantities.cacheCreation,
    billingEntries: args.usage.billable
      ? piEdgeBillingEntries(args.usage.model, quantities)
      : [],
  };
}

function piMessageEvent(args: {
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly expectedVersion: number;
  readonly expectedLastOrdinal: number;
  readonly message: PiAgentMessage;
  readonly handoff: boolean;
}): AgentEvent {
  return {
    type: PI_MESSAGE_COMPLETED_EVENT_TYPE,
    source: "api",
    sequenceNumber: args.sequenceNumber,
    messageId: `${args.runId}/${args.sequenceNumber}`,
    expectedVersion: args.expectedVersion,
    expectedLastOrdinal: args.expectedLastOrdinal,
    message: args.message,
    ...(args.handoff ? { handoff: { from: "api", to: "sandbox" } } : {}),
  };
}

function failedAssistantMessage(message: PiAgentMessage): string | null {
  if (
    message.role !== "assistant" ||
    (message.stopReason !== "error" && message.stopReason !== "aborted")
  ) {
    return null;
  }
  return message.errorMessage ?? `Pi model turn ${message.stopReason}`;
}

function piEdgeFailure(runId: string, error: unknown): string {
  L.error("Pi edge turn failed", { runId, error });
  return error instanceof Error ? error.message : "Pi edge turn failed";
}

async function deliverPiEdgeAxiomTrace(
  payload: EventConsumerPayload,
  signal: AbortSignal,
): Promise<void> {
  await ingestAxiomEvents(payload, signal);
  signal.throwIfAborted();
}

function piEdgeCompletionBody(args: {
  readonly runId: string;
  readonly failure: string | undefined;
  readonly lastEventSequence: number | undefined;
}) {
  return {
    runId: args.runId,
    exitCode: args.failure === undefined ? 0 : 1,
    ...(args.failure === undefined ? {} : { error: args.failure }),
    ...(args.lastEventSequence === undefined
      ? {}
      : { lastEventSequence: args.lastEventSequence }),
  };
}

interface PiEdgeProgress {
  lastEventSequence: number | undefined;
  modelFailure: string | null;
}

const projectPiEdgeEvent$ = command(
  async (
    { set },
    payload: EventConsumerPayload,
    signal: AbortSignal,
    modelUsage?: PiEdgeModelUsage,
  ) => {
    const projection = await set(
      materializeRunOutputEvents$,
      payload,
      signal,
      modelUsage,
    );
    signal.throwIfAborted();
    if (projection) {
      await publishMaterializedChatProjection(payload, projection, signal);
      signal.throwIfAborted();
    }
    await deliverPiEdgeAxiomTrace(payload, signal);
    signal.throwIfAborted();
  },
);

const executePiEdgeModelTurn$ = command(
  async (
    { set },
    args: PiEdgeTurnArgs,
    progress: PiEdgeProgress,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const thread = await chatThreadForRunFromDb(db, args.runId);
    signal.throwIfAborted();
    if (!thread) {
      throw new Error("Pi edge turn requires a chat thread");
    }
    const transcript = await readPiTranscript(
      db,
      thread.chatThreadId,
      {},
      signal,
    );
    signal.throwIfAborted();
    const priorMessages = parsePiAgentMessages(
      transcript.messages.map((message) => {
        return message.payload;
      }),
    );
    let sequenceNumber = 1;
    let expectedLastOrdinal = transcript.lastOrdinal;

    const project = async (
      message: PiAgentMessage,
      handoff: boolean,
    ): Promise<void> => {
      const payload: EventConsumerPayload = {
        runId: args.runId,
        events: [
          piMessageEvent({
            runId: args.runId,
            sequenceNumber,
            expectedVersion: transcript.version,
            expectedLastOrdinal,
            message,
            handoff,
          }),
        ],
        context: { userId: args.userId, orgId: args.orgId },
      };
      const modelUsage = piEdgeModelUsage({
        messageId: `${args.runId}/${sequenceNumber}`,
        usage: args.usage,
        message,
      });
      await set(projectPiEdgeEvent$, payload, signal, modelUsage);
      signal.throwIfAborted();
      progress.lastEventSequence = sequenceNumber;
      sequenceNumber += 1;
      expectedLastOrdinal += 1;
    };

    await runPiAgentPrompt(
      {
        model: args.model,
        systemPrompt: args.systemPrompt,
        prompt: args.prompt,
        messages: priorMessages,
        executionEnv: args.executionEnv,
        async onMessage(message) {
          const requiresSandbox = piMessageRequiresSandbox(message);
          await project(message, requiresSandbox);
          signal.throwIfAborted();
          progress.modelFailure ??= failedAssistantMessage(message);
          if (!requiresSandbox) {
            return;
          }
          await dispatchPiSandboxHandoff(
            { runId: args.runId, runnerGroup: args.runnerGroup },
            signal,
          );
          signal.throwIfAborted();
          throw new PiHandoffRequested();
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (progress.modelFailure !== null) {
      throw new Error(progress.modelFailure);
    }
  },
);
/**
 * Runs an eligible Pi turn inside the API with Pi's native agent loop. Read
 * batches execute against the pinned Storage ExecutionEnv. A complete
 * assistant batch containing any sandbox-only tool is committed first, then
 * wakes the standby runtime and ends the API writer without completing the run.
 */
export const runPiEdgeTurn$ = command(
  async ({ set }, args: PiEdgeTurnArgs, signal: AbortSignal): Promise<void> => {
    const progress: PiEdgeProgress = {
      lastEventSequence: undefined,
      modelFailure: null,
    };
    const outcome = await settle(
      set(executePiEdgeModelTurn$, args, progress, signal),
    );
    signal.throwIfAborted();
    if (!outcome.ok && outcome.error instanceof PiHandoffRequested) {
      L.debug("Pi edge turn handed off", {
        runId: args.runId,
        skillSnapshotDigest: args.skillSnapshot.digest,
      });
      return;
    }

    const failure = outcome.ok
      ? undefined
      : piEdgeFailure(args.runId, outcome.error);

    const result = await set(
      completeAgentRun$,
      {
        auth: { userId: args.userId, orgId: args.orgId, runId: args.runId },
        allowCheckpointlessSuccess: true,
        body: piEdgeCompletionBody({
          runId: args.runId,
          failure,
          lastEventSequence: progress.lastEventSequence,
        }),
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
      signal.throwIfAborted();
    }
    await publishPiStandbyReleaseToRunnerGroupSafely(
      args.runnerGroup,
      args.runId,
    );
    signal.throwIfAborted();
  },
);
