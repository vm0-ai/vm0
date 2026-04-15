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

  it("should filter out items missing required fields from the events array", async () => {
    setup();

    server.use(
      http.get("*/api/zero/voice-chat/sess-validate/context", () => {
        return HttpResponse.json({
          events: [
            // Valid event
            {
              id: "evt-ok",
              seq: 1,
              source: "slow-brain",
              type: "thinking",
              content: "Valid",
              createdAt: "2026-04-13T10:00:01Z",
            },
            // Missing id — should be filtered out
            {
              seq: 2,
              source: "user",
              type: "speech",
              content: "No id",
              createdAt: "2026-04-13T10:00:02Z",
            },
            // seq is a string, not number — should be filtered out
            {
              id: "evt-bad-seq",
              seq: "3",
              source: "fast-brain",
              type: "response",
              content: "Bad seq",
              createdAt: "2026-04-13T10:00:03Z",
            },
            // null item — should be filtered out
            null,
            // content is undefined (field absent) — should be filtered out
            {
              id: "evt-no-content",
              seq: 4,
              source: "user",
              type: "speech",
              createdAt: "2026-04-13T10:00:04Z",
            },
          ],
        });
      }),
    );

    const signals = createVoiceChatPanelSignals("sess-validate");
    detach(
      context.store.set(signals.startPolling$, context.signal),
      Reason.Daemon,
    );

    await waitFor(() => {
      const events = context.store.get(signals.events$);
      // Only the one valid event should be present
      expect(events).toHaveLength(1);
    });

    const events = context.store.get(signals.events$);
    expect(events[0]).toMatchObject({ id: "evt-ok", seq: 1 });
  });

  it("should return false from polling and not set events on non-ok response", async () => {
    setup();

    const pollFired = createDeferredPromise<void>(context.signal);
    server.use(
      http.get("*/api/zero/voice-chat/sess-error/context", () => {
        pollFired.resolve();
        return new HttpResponse(null, { status: 500 });
      }),
    );

    const signals = createVoiceChatPanelSignals("sess-error");
    detach(
      context.store.set(signals.startPolling$, context.signal),
      Reason.Daemon,
    );

    // Wait until the poll has fired at least once
    await pollFired.promise;

    // Events remain empty after a failed response
    expect(context.store.get(signals.events$)).toHaveLength(0);
  });
});
