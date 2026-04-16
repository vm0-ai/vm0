/**
 * Tests for VoiceChatPanelContent component.
 *
 * Rendered in the Mission Control task panel when an active voice_chat task
 * is present. The component polls /api/zero/voice-chat/:sessionId/context
 * and renders events via VoiceChatEventItem.
 *
 * Covers:
 * - MC-VCP-001: Empty state — shows placeholder text when no events exist
 * - MC-VCP-002: Events state — shows event bubbles when events arrive via poll
 *
 * See: turbo/apps/platform/src/views/mission-control-page/voice-chat-panel-content.tsx
 * Related commits: #9592 (replace two-panel layout with unified conversation view)
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const SESSION_ID = "vc-panel-session-001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ContextEvent {
  id: string;
  seq: number;
  source: string;
  type: string;
  content: string | null;
  createdAt: string;
}

/**
 * Set up mission-control with a voice_chat task and open the panel by clicking
 * the task card. Returns the userEvent instance for further interactions.
 *
 * The context mock handler returns events only on the first poll (after=0) and
 * empty on subsequent polls, preventing setLoop from exceeding the test
 * iteration limit.
 */
async function setupAndOpenVoiceChatPanel(events: ContextEvent[]) {
  server.use(
    http.get("*/api/zero/tasks", () => {
      return HttpResponse.json({
        tasks: [
          {
            id: "task-vcp-001",
            type: "voice_chat",
            title: "Voice session",
            summary: null,
            agent: {
              id: "c0000000-0000-4000-a000-000000000001",
              name: "zero",
              displayName: null,
              avatarUrl: null,
            },
            latestRunId: null,
            status: null,
            voiceChatSessionId: SESSION_ID,
            createdAt: "2026-04-17T00:00:00Z",
            updatedAt: "2026-04-17T00:00:00Z",
          },
        ],
      });
    }),
    http.get(`*/api/zero/voice-chat/${SESSION_ID}/context`, ({ request }) => {
      const url = new URL(request.url);
      const after = Number(url.searchParams.get("after") ?? 0);
      // Return events only on the first poll; subsequent polls return empty
      // so setLoop terminates gracefully within the test iteration limit.
      if (after === 0) {
        return HttpResponse.json({ events });
      }
      return HttpResponse.json({ events: [] });
    }),
  );

  const user = userEvent.setup();
  detachedSetupPage({
    context,
    path: "/_/mission-control",
    featureSwitches: { [FeatureSwitchKey.VoiceChat]: true },
  });

  // Click the task card to open the voice chat panel
  const taskCard = await waitFor(() => {
    return screen.getByText("Voice session");
  });
  await user.click(taskCard);

  await waitFor(() => {
    expect(screen.getByLabelText("Close task")).toBeInTheDocument();
  });

  return user;
}

// ---------------------------------------------------------------------------
// MC-VCP-001: Empty state
// ---------------------------------------------------------------------------

describe("voice-chat-panel-content - empty state (MC-VCP-001)", () => {
  it("shows 'No conversation events yet' when no events exist", async () => {
    await setupAndOpenVoiceChatPanel([]);

    await waitFor(() => {
      expect(
        screen.getByText("No conversation events yet"),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// MC-VCP-002: Events rendered
// ---------------------------------------------------------------------------

describe("voice-chat-panel-content - events rendered (MC-VCP-002)", () => {
  it("renders event content when the context poll returns events", async () => {
    await setupAndOpenVoiceChatPanel([
      {
        id: "evt-panel-001",
        seq: 1,
        source: "user",
        type: "speech",
        content: "Schedule a meeting for tomorrow",
        createdAt: "2026-04-17T00:00:01Z",
      },
      {
        id: "evt-panel-002",
        seq: 2,
        source: "fast-brain",
        type: "response",
        content: "Sure, I will schedule it.",
        createdAt: "2026-04-17T00:00:02Z",
      },
    ]);

    await waitFor(() => {
      expect(
        screen.getByText("Schedule a meeting for tomorrow"),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Sure, I will schedule it.")).toBeInTheDocument();

    // The empty state message should NOT be visible
    expect(
      screen.queryByText("No conversation events yet"),
    ).not.toBeInTheDocument();
  });
});
