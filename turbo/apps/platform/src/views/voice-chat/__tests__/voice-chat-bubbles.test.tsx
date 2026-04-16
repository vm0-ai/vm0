/**
 * Tests for VoiceChatEventItem, VoiceUserBubble, VoiceAssistantBubble,
 * and SlowBrainIndicator components.
 *
 * Rendered via the mission-control page with an active voice_chat task.
 * Clicking the task card opens the VoiceChatPanelContent which renders
 * events via VoiceChatEventItem.
 *
 * Covers:
 * - VC-B-001: User speech event renders a user bubble
 * - VC-B-002: Fast-brain response renders an assistant bubble
 * - VC-B-003: Slow-brain event renders the SlowBrainIndicator label
 * - VC-B-004: SlowBrainIndicator content is collapsible via <details> element
 * - VC-B-005: Empty slow-brain content does not render a <details> element
 *
 * See: turbo/apps/platform/src/views/voice-chat/voice-chat-bubbles.tsx
 * Related commits: #9652 (make slow-brain indicator content collapsible)
 *                  #9592 (replace two-panel layout with unified conversation view)
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

function createAgent() {
  return {
    id: "agent-1",
    name: "test-agent",
    displayName: "Test Agent",
    avatarUrl: null,
  };
}

function mockTasksAndContext(
  sessionId: string,
  taskId: string,
  runId: string,
  events: {
    id: string;
    seq: number;
    source: string;
    type: string;
    content: string | null;
    createdAt: string;
  }[],
) {
  server.use(
    http.get("*/api/zero/tasks", () => {
      return HttpResponse.json({
        tasks: [
          {
            id: taskId,
            type: "voice_chat",
            title: "Voice session",
            summary: null,
            agent: createAgent(),
            latestRunId: runId,
            status: "running",
            voiceChatSessionId: sessionId,
            createdAt: "2026-04-17T00:00:00Z",
            updatedAt: "2026-04-17T00:00:00Z",
          },
        ],
      });
    }),
    http.get(`*/api/zero/voice-chat/${sessionId}/context`, ({ request }) => {
      const url = new URL(request.url);
      const after = Number(url.searchParams.get("after") ?? 0);
      // Return events only on the first poll (after=0); subsequent polls return
      // empty so setLoop does not accumulate events or exceed the test iteration limit.
      if (after === 0) {
        return HttpResponse.json({ events });
      }
      return HttpResponse.json({ events: [] });
    }),
  );
}

async function openVoiceChatPanel(sessionId: string) {
  const user = userEvent.setup();
  detachedSetupPage({
    context,
    path: "/_/mission-control",
    featureSwitches: { [FeatureSwitchKey.VoiceChat]: true },
  });

  const title = await waitFor(() => {
    return screen.getByText("Voice session");
  });
  await user.click(title);

  await waitFor(() => {
    expect(screen.getByLabelText("Close task")).toBeInTheDocument();
  });

  return user;
}

describe("voice-chat-bubbles", () => {
  // ---------------------------------------------------------------------------
  // VC-B-001: User speech bubble
  // ---------------------------------------------------------------------------

  it("renders user bubble content for speech events from user source (VC-B-001)", async () => {
    mockTasksAndContext("vc-b-001", "task-vc-b-001", "run-vc-b-001", [
      {
        id: "evt-001",
        seq: 1,
        source: "user",
        type: "speech",
        content: "Hello from user",
        createdAt: "2026-04-17T00:00:01Z",
      },
    ]);

    await openVoiceChatPanel("vc-b-001");

    await waitFor(() => {
      expect(screen.getByText("Hello from user")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // VC-B-002: Assistant response bubble
  // ---------------------------------------------------------------------------

  it("renders assistant bubble content for response events from fast-brain source (VC-B-002)", async () => {
    mockTasksAndContext("vc-b-002", "task-vc-b-002", "run-vc-b-002", [
      {
        id: "evt-002",
        seq: 2,
        source: "fast-brain",
        type: "response",
        content: "Hello from assistant",
        createdAt: "2026-04-17T00:00:02Z",
      },
    ]);

    await openVoiceChatPanel("vc-b-002");

    await waitFor(() => {
      expect(screen.getByText("Hello from assistant")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // VC-B-003: Slow-brain label renders
  // ---------------------------------------------------------------------------

  it("renders the slow-brain type label for slow-brain events (VC-B-003)", async () => {
    mockTasksAndContext("vc-b-003", "task-vc-b-003", "run-vc-b-003", [
      {
        id: "evt-003",
        seq: 3,
        source: "slow-brain",
        type: "thinking",
        content: "Analyzing the request...",
        createdAt: "2026-04-17T00:00:03Z",
      },
    ]);

    await openVoiceChatPanel("vc-b-003");

    await waitFor(() => {
      expect(screen.getByText("Thinking")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // VC-B-004: Slow-brain content is collapsible (<details>)
  // ---------------------------------------------------------------------------

  it("renders a details element for slow-brain events with non-empty content (VC-B-004)", async () => {
    mockTasksAndContext("vc-b-004", "task-vc-b-004", "run-vc-b-004", [
      {
        id: "evt-004",
        seq: 4,
        source: "slow-brain",
        type: "directive",
        content: "Performing deep analysis of the documents",
        createdAt: "2026-04-17T00:00:04Z",
      },
    ]);

    await openVoiceChatPanel("vc-b-004");

    await waitFor(() => {
      expect(screen.getByText("Directive")).toBeInTheDocument();
    });

    // Content must be inside a collapsible <details> element (added in #9652)
    const detailsEl = document.querySelector("details");
    expect(detailsEl).not.toBeNull();
    expect(detailsEl?.textContent).toContain(
      "Performing deep analysis of the documents",
    );
  });

  // ---------------------------------------------------------------------------
  // VC-B-005: Slow-brain with null content shows no details element
  // ---------------------------------------------------------------------------

  it("does not render a details element when slow-brain content is null (VC-B-005)", async () => {
    mockTasksAndContext("vc-b-005", "task-vc-b-005", "run-vc-b-005", [
      {
        id: "evt-005",
        seq: 5,
        source: "slow-brain",
        type: "observation",
        content: null,
        createdAt: "2026-04-17T00:00:05Z",
      },
    ]);

    await openVoiceChatPanel("vc-b-005");

    await waitFor(() => {
      expect(screen.getByText("Observation")).toBeInTheDocument();
    });

    expect(document.querySelector("details")).toBeNull();
  });
});
