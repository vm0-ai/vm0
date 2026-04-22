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
  VoiceCandidateToolCallBubble,
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

  function makeTask(
    overrides: Partial<{
      id: string;
      prompt: string;
      status: "pending" | "queued" | "running" | "done" | "failed";
      assistantMessages: {
        type: "assistant";
        content: string;
        at: string;
      }[];
      error: string | null;
    }>,
  ) {
    return {
      id: "33333333-3333-4333-8333-333333333333",
      sessionId: SESSION_ID,
      runId: null,
      callId: "call-1",
      prompt: "do the thing",
      status: "done" as const,
      assistantMessages: [],
      error: null,
      createdAt: "2026-04-20T00:00:00Z",
      startedAt: null,
      finishedAt: null,
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
    const task = makeTask({ id: taskId, assistantMessages: [] });
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

  // ---------------------------------------------------------------------------
  // VCC-003: task_result uses assistantMessages when item.content is absent
  // ---------------------------------------------------------------------------

  it("task_result falls back to joinResultEntries(task.assistantMessages) when item.content is null", () => {
    const taskId = "44444444-4444-4444-8444-444444444444";
    const task = makeTask({
      id: taskId,
      assistantMessages: [
        {
          type: "assistant" as const,
          content: "step 1 done",
          at: "2026-04-20T00:00:00Z",
        },
        {
          type: "assistant" as const,
          content: "step 2 done",
          at: "2026-04-20T00:01:00Z",
        },
      ],
    });
    renderWithStore(
      <VoiceCandidateItemBubble
        item={item({ role: "task_result", content: null, taskId })}
        taskById={{ [taskId]: task }}
      />,
    );
    expect(screen.getByText(/task result/i)).toBeInTheDocument();
    expect(screen.getByText("do the thing")).toBeInTheDocument();
    // joined with double newline separator — Markdown renders each paragraph separately
    expect(screen.getByText("step 1 done")).toBeInTheDocument();
    expect(screen.getByText("step 2 done")).toBeInTheDocument();
  });

  it("task_result prefers item.content over assistantMessages when both are present", () => {
    const taskId = "55555555-5555-4555-8555-555555555555";
    const task = makeTask({
      id: taskId,
      assistantMessages: [
        {
          type: "assistant" as const,
          content: "from messages",
          at: "2026-04-20T00:00:00Z",
        },
      ],
    });
    renderWithStore(
      <VoiceCandidateItemBubble
        item={item({ role: "task_result", content: "from content", taskId })}
        taskById={{ [taskId]: task }}
      />,
    );
    expect(screen.getByText("from content")).toBeInTheDocument();
    expect(screen.queryByText("from messages")).not.toBeInTheDocument();
  });

  it("task_result with empty assistantMessages shows prompt but no result text", () => {
    const taskId = "66666666-6666-4666-8666-666666666666";
    const task = makeTask({ id: taskId, assistantMessages: [] });
    renderWithStore(
      <VoiceCandidateItemBubble
        item={item({ role: "task_result", content: null, taskId })}
        taskById={{ [taskId]: task }}
      />,
    );
    expect(screen.getByText(/task result/i)).toBeInTheDocument();
    expect(screen.getByText("do the thing")).toBeInTheDocument();
    // no result text rendered when both content and assistantMessages are falsy
    expect(screen.queryByText(/step [12] done/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// VCC-004: VoiceCandidateToolCallBubble
// ---------------------------------------------------------------------------

describe("voiceCandidateToolCallBubble", () => {
  it("renders prompt and status label for pending status", () => {
    renderWithStore(
      <VoiceCandidateToolCallBubble
        prompt="book me a flight"
        status="pending"
      />,
    );
    expect(screen.getByText("book me a flight")).toBeInTheDocument();
    expect(screen.getByText("calling")).toBeInTheDocument(); // pending → "calling"
    expect(screen.getByText("create_task")).toBeInTheDocument();
  });

  it("renders queued status label", () => {
    renderWithStore(
      <VoiceCandidateToolCallBubble prompt="some task" status="queued" />,
    );
    expect(screen.getByText("queued")).toBeInTheDocument();
  });

  it("renders running status label", () => {
    renderWithStore(
      <VoiceCandidateToolCallBubble prompt="running task" status="running" />,
    );
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("renders done status label", () => {
    renderWithStore(
      <VoiceCandidateToolCallBubble prompt="done task" status="done" />,
    );
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("renders failed status label", () => {
    renderWithStore(
      <VoiceCandidateToolCallBubble prompt="failed task" status="failed" />,
    );
    expect(screen.getByText("failed")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// VCC-005: bubble components direct render
// ---------------------------------------------------------------------------

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
