import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createVoiceChatPanelSignals } from "../create-voice-chat-panel-signals.ts";
import { createDeferredPromise, detach, Reason } from "../../utils.ts";

const context = testContext();

function setup() {
  detachedSetupPage({
    context,
    path: "/",
    withoutRender: true,
  });
}

describe("createVoiceChatPanelSignals", () => {
  it("should start with empty events list", () => {
    setup();
    const signals = createVoiceChatPanelSignals("sess-1");
    const events = context.store.get(signals.events$);
    expect(events).toHaveLength(0);
  });

  it("should accumulate valid events from polling and advance lastSeq", async () => {
    setup();

    server.use(
      http.get("*/api/zero/voice-chat/sess-poll/context", ({ request }) => {
        const url = new URL(request.url);
        const after = Number(url.searchParams.get("after") ?? 0);
        if (after === 0) {
          return HttpResponse.json({
            events: [
              {
                id: "evt-1",
                seq: 1,
                source: "slow-brain",
                type: "thinking",
                content: "Analyzing context",
                createdAt: "2026-04-13T10:00:01Z",
              },
              {
                id: "evt-2",
                seq: 2,
                source: "user",
                type: "speech",
                content: "Hello",
                createdAt: "2026-04-13T10:00:02Z",
              },
            ],
          });
        }
        // Subsequent polls return no new events
        return HttpResponse.json({ events: [] });
      }),
    );

    const signals = createVoiceChatPanelSignals("sess-poll");
    detach(
      context.store.set(signals.startPolling$, context.signal),
      Reason.Daemon,
    );

    await waitFor(() => {
      const events = context.store.get(signals.events$);
      expect(events).toHaveLength(2);
    });

    const events = context.store.get(signals.events$);
    expect(events[0]).toMatchObject({
      id: "evt-1",
      seq: 1,
      source: "slow-brain",
      type: "thinking",
      content: "Analyzing context",
    });
    expect(events[1]).toMatchObject({
      id: "evt-2",
      seq: 2,
      source: "user",
      type: "speech",
      content: "Hello",
    });
  });

  it("should keep events$ empty when polling hits an error response", async () => {
    setup();

    const pollFired = createDeferredPromise<void>(context.signal);
    server.use(
      http.get("*/api/zero/voice-chat/sess-error/context", () => {
        pollFired.resolve();
        return HttpResponse.json(
          { error: { message: "boom", code: "INTERNAL" } },
          { status: 500 },
        );
      }),
    );

    const signals = createVoiceChatPanelSignals("sess-error");
    detach(
      context.store.set(signals.startPolling$, context.signal),
      Reason.Daemon,
    );

    // Wait until the poll has fired at least once. accept() throws on 500
    // and setLoop catches the error and applies fibonacci backoff — the
    // observable invariant is that events$ stays empty.
    await pollFired.promise;

    expect(context.store.get(signals.events$)).toHaveLength(0);
  });
});
