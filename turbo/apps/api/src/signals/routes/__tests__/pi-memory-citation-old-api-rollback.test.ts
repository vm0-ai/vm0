import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { describe, expect, it } from "vitest";

interface RollbackWireFixture {
  readonly baselineCommit: string;
  readonly privateValues: readonly string[];
  readonly visibleText: string;
  readonly wirePayload: unknown;
}

interface BaselineEvent extends Record<string, unknown> {
  readonly type: string;
  readonly sequenceNumber: number;
}

// Executable copies of the rollback baseline's endpoint and consumer behavior.
// Keep these pinned to e5cbf8b3fff605d41581d511fc890a6d87a9bdbe:
// - api-contracts/src/contracts/webhooks.ts (agentEventSchema + body)
// - agent-webhook-events.service.ts (immutable accepted payload)
// - agent-event-consumer-axiom.service.ts (eventData)
// - run-detail.service.ts (Activity returns eventData unchanged)
const baselineAgentEventSchema = z
  .object({
    type: z.string(),
    sequenceNumber: z.number().int().nonnegative(),
  })
  .passthrough();
const baselineEventsBodySchema = z.object({
  runId: z.string().min(1, "runId is required"),
  events: z
    .array(baselineAgentEventSchema)
    .min(1, "events array cannot be empty"),
});

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function baselineAssistantText(event: BaselineEvent): string | null {
  if (event.type !== "assistant") {
    return null;
  }
  const content = recordOf(event.message)?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.flatMap((block) => {
    const value = recordOf(block);
    return value?.type === "text" && typeof value.text === "string"
      ? [value.text]
      : [];
  });
  return parts.length === 0 ? null : parts.join("\n\n");
}

function executeRollbackBaseline(wirePayload: unknown) {
  const parsedBody = baselineEventsBodySchema.parse(wirePayload);
  const acceptedPayload = Object.freeze({
    runId: parsedBody.runId,
    events: Object.freeze([...parsedBody.events]),
    context: Object.freeze({ userId: "rollback-user", orgId: "rollback-org" }),
  });
  const axiomInput = acceptedPayload.events.map((event) => {
    return {
      runId: acceptedPayload.runId,
      userId: acceptedPayload.context.userId,
      sequenceNumber: event.sequenceNumber,
      eventType: event.type,
      eventData: event,
    };
  });
  const activity = axiomInput.map((event) => {
    return {
      sequenceNumber: event.sequenceNumber,
      eventType: event.eventType,
      eventData: event.eventData,
    };
  });
  const chatProjection = acceptedPayload.events.flatMap((event) => {
    const content = baselineAssistantText(event);
    return content === null ? [] : [{ content }];
  });
  const callback = [...acceptedPayload.events].reverse().find((event) => {
    return event.type === "result" && typeof event.result === "string";
  })?.result;

  return {
    parsedBody,
    acceptedPayload,
    axiomInput,
    activity,
    callback,
    chatProjection,
    optionalConsumers: [acceptedPayload, acceptedPayload],
  };
}

const fixturePath = fileURLToPath(
  new URL(
    "../../../../../../../fixtures/pi-memory-citation-new-guest-wire.json",
    import.meta.url,
  ),
);
const fixture = JSON.parse(
  readFileSync(fixturePath, "utf8"),
) as RollbackWireFixture;

describe("new Pi Guest to old API rollback privacy", () => {
  it("strips the exact private sidecar before every baseline consumer", () => {
    expect(fixture.baselineCommit).toBe(
      "e5cbf8b3fff605d41581d511fc890a6d87a9bdbe",
    );
    const rollback = executeRollbackBaseline(fixture.wirePayload);

    expect(rollback.parsedBody).not.toHaveProperty("piMemoryCitationTransport");
    expect(rollback.chatProjection).toStrictEqual([
      { content: fixture.visibleText },
    ]);
    expect(rollback.callback).toBe(fixture.visibleText);
    for (const consumer of [
      rollback.parsedBody,
      rollback.acceptedPayload,
      rollback.axiomInput,
      rollback.activity,
      rollback.chatProjection,
      rollback.callback,
      rollback.optionalConsumers,
    ]) {
      const serialized = JSON.stringify(consumer);
      expect(serialized).not.toContain("memoryCitation");
      expect(serialized).not.toContain("piMemoryCitationTransport");
      expect(serialized).not.toContain("oai-mem-citation");
      for (const privateValue of fixture.privateValues) {
        expect(serialized).not.toContain(privateValue);
      }
    }
  });
});
