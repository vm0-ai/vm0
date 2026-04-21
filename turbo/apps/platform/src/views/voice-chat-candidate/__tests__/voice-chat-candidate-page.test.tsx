import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createStore } from "ccstate";
import { StoreProvider } from "ccstate-react";
import type { ReactElement } from "react";
import {
  VoiceCandidateItemBubble,
  VoiceCandidateTaskResultBubble,
  VoiceCandidateSystemNoteBubble,
  VoiceCandidateUserBubble,
  VoiceCandidateAssistantBubble,
} from "../voice-chat-candidate-bubbles.tsx";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

function renderWithStore(element: ReactElement) {
  const store = createStore();
  return render(<StoreProvider value={store}>{element}</StoreProvider>);
}

const pageContext = testContext();

// ---------------------------------------------------------------------------
// VCC-001: page-level render with feature disabled
// ---------------------------------------------------------------------------

describe("voice-chat-candidate page - feature disabled (VCC-001)", () => {
  it("shows not-available message when voiceChat feature switch is off", async () => {
    detachedSetupPage({
      context: pageContext,
      path: "/voice-chat-candidate",
    });
    // `findBy*` auto-waits; `.resolves` satisfies jest-prefer-expect-resolves.
    await expect(
      screen.findByText(/not available for your account/i),
    ).resolves.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// VCC-002: page-level render with feature enabled — idle state
// ---------------------------------------------------------------------------

describe("voice-chat-candidate page - idle state quick chat (VCC-002)", () => {
  it("start voice chat button is enabled when voiceChat is on and an agent is available", async () => {
    detachedSetupPage({
      context: pageContext,
      path: "/voice-chat-candidate",
      featureSwitches: { voiceChat: true },
    });

    // Mirrors sibling VC-003 (voice-chat-page.test.tsx): waitFor retries the
    // compound predicate (button exists AND is enabled) across render cycles.
    const btn = await waitFor(() => {
      const el = screen.getAllByRole("button").find((b) => {
        return /start voice chat/i.test(b.textContent ?? "");
      });
      expect(el).toBeDefined();
      expect(el).not.toBeDisabled();
      return el;
    });
    expect(btn).toBeInTheDocument();
  });
});

describe("voice-candidate-item-bubble dispatcher", () => {
  const SESSION_ID = "11111111-1111-4111-8111-111111111111";

  function item(
    overrides: Partial<{
      id: string;
      role: "user" | "assistant" | "task_result" | "system_note";
      content: string | null;
      taskId: string | null;
      realtimeItemId: string | null;
      seq: number;
    }>,
  ) {
    return {
      id: "00000000-0000-4000-8000-000000000001",
      sessionId: SESSION_ID,
      seq: 1,
      role: "user" as const,
      content: "",
      taskId: null,
      realtimeItemId: null,
      createdAt: "2026-04-20T00:00:00Z",
      ...overrides,
    };
  }

  it("renders user role via user bubble", () => {
    renderWithStore(
      <VoiceCandidateItemBubble
        item={item({ role: "user", content: "hello" })}
        taskById={{}}
      />,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("renders assistant role via assistant bubble", () => {
    renderWithStore(
      <VoiceCandidateItemBubble
        item={item({ role: "assistant", content: "hi there" })}
        taskById={{}}
      />,
    );
    expect(screen.getByText("hi there")).toBeInTheDocument();
  });

  it("renders task_result role with task prompt from taskById", () => {
    const taskId = "33333333-3333-4333-8333-333333333333";
    const task = {
      id: taskId,
      sessionId: SESSION_ID,
      runId: null,
      callId: "call-1",
      prompt: "do the thing",
      status: "done" as const,
      assistantMessages: [
        {
          type: "assistant" as const,
          content: "done!",
          at: "2026-04-20T00:00:00Z",
        },
      ],
      error: null,
      createdAt: "2026-04-20T00:00:00Z",
      startedAt: null,
      finishedAt: null,
    };
    renderWithStore(
      <VoiceCandidateItemBubble
        item={item({
          role: "task_result",
          content: "done!",
          taskId,
        })}
        taskById={{ [taskId]: task }}
      />,
    );
    expect(screen.getByText(/task result/i)).toBeInTheDocument();
    expect(screen.getByText("do the thing")).toBeInTheDocument();
    expect(screen.getByText("done!")).toBeInTheDocument();
  });

  it("renders system_note role via system-note bubble", () => {
    renderWithStore(
      <VoiceCandidateItemBubble
        item={item({ role: "system_note", content: "connection restored" })}
        taskById={{}}
      />,
    );
    expect(screen.getByText("connection restored")).toBeInTheDocument();
  });
});

describe("bubble components (direct)", () => {
  it("user bubble returns null for whitespace-only content", () => {
    const { container } = renderWithStore(
      <VoiceCandidateUserBubble content="   " />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("assistant bubble returns null for empty content", () => {
    const { container } = renderWithStore(
      <VoiceCandidateAssistantBubble content="" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("task-result bubble shows error when error is present", () => {
    renderWithStore(
      <VoiceCandidateTaskResultBubble
        prompt="a prompt"
        result={null}
        error="it broke"
      />,
    );
    expect(screen.getByText("it broke")).toBeInTheDocument();
  });

  it("system-note bubble shows the note content", () => {
    renderWithStore(<VoiceCandidateSystemNoteBubble content="heads up" />);
    expect(screen.getByText("heads up")).toBeInTheDocument();
  });
});
