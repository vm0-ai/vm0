import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setChatAgentId$ } from "../../agent-chat.ts";
import {
  meetingPrepStatus$,
  meetingPrepPrompt$,
  meetingPrepStartTime$,
  triggerPreparation$,
  clearPreparation$,
} from "../voice-chat-preparation.ts";

const context = testContext();

const TEST_AGENT_ID = "agent-123";

function setup() {
  detachedSetupPage({
    context,
    path: "/",
    withoutRender: true,
  });
  context.store.set(setChatAgentId$, TEST_AGENT_ID);
}

function mockPrepareEndpoint(responses: { status: string; id?: string }[]) {
  let callIndex = 0;
  const counter = {
    get count() {
      return callIndex;
    },
  };
  server.use(
    http.post("*/api/zero/voice-chat/prepare", () => {
      const responseIndex = Math.min(callIndex, responses.length - 1);
      const response = responses[responseIndex];
      callIndex++;
      return HttpResponse.json({
        preparation: {
          id: response.id ?? "prep-1",
          status: response.status,
        },
      });
    }),
  );
  return counter;
}

describe("voice-chat-preparation signals", () => {
  it("should set status to ready when preparation is cached", async () => {
    setup();
    const responses = [{ status: "ready" }];
    mockPrepareEndpoint(responses);

    await context.store.set(
      triggerPreparation$,
      "discuss quarterly goals",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("ready");
    expect(context.store.get(meetingPrepPrompt$)).toBe(
      "discuss quarterly goals",
    );
    expect(context.store.get(meetingPrepStartTime$)).toBeTypeOf("number");
  });

  it("should poll until ready when preparation is in progress", async () => {
    setup();
    const responses = [
      { status: "preparing" },
      { status: "preparing" },
      { status: "ready" },
    ];
    const counter = mockPrepareEndpoint(responses);

    await context.store.set(
      triggerPreparation$,
      "review sprint items",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("ready");
    // Initial call + 2 poll calls (preparing, ready)
    expect(counter.count).toBeGreaterThanOrEqual(3);
  });

  it("should set status to failed when preparation fails during poll", async () => {
    setup();
    const responses = [{ status: "preparing" }, { status: "failed" }];
    mockPrepareEndpoint(responses);

    await context.store.set(
      triggerPreparation$,
      "team standup",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("failed");
  });

  it("should set status to failed when endpoint returns error", async () => {
    setup();
    server.use(
      http.post("*/api/zero/voice-chat/prepare", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await context.store.set(
      triggerPreparation$,
      "error prompt",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("failed");
  });

  it("should set status to failed when no agent is selected", async () => {
    setup();
    context.store.set(setChatAgentId$, null);

    await context.store.set(
      triggerPreparation$,
      "no agent prompt",
      context.signal,
    );

    expect(context.store.get(meetingPrepStatus$)).toBe("failed");
  });

  it("should reset all state on clearPreparation$", async () => {
    setup();
    const responses = [{ status: "ready" }];
    mockPrepareEndpoint(responses);

    await context.store.set(triggerPreparation$, "some prompt", context.signal);

    expect(context.store.get(meetingPrepStatus$)).toBe("ready");

    context.store.set(clearPreparation$);

    expect(context.store.get(meetingPrepStatus$)).toBe("idle");
    expect(context.store.get(meetingPrepPrompt$)).toBeNull();
    expect(context.store.get(meetingPrepStartTime$)).toBeNull();
  });
});
