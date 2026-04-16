import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { state, command, createStore } from "ccstate";
import { StoreProvider } from "ccstate-react";
import type { ReactNode } from "react";
import { VoiceChatPanelContent } from "../voice-chat-panel-content.tsx";
import type {
  VoiceChatPanelSignals,
  VoiceChatEvent,
} from "../../../signals/mission-control-page/create-voice-chat-panel-signals.ts";

// MC-D-002 — VoiceChatPanelContent event rendering

function makeSignals(initialEvents: VoiceChatEvent[] = []): {
  signals: VoiceChatPanelSignals;
  store: ReturnType<typeof createStore>;
} {
  const store = createStore();
  const events$ = state<VoiceChatEvent[]>(initialEvents);
  const startPolling$ = command<Promise<void>, [AbortSignal]>(
    async (_signal: AbortSignal) => {},
  );
  const focusInput$ = command<void, []>(() => {});

  const signals: VoiceChatPanelSignals = {
    sessionId: "test-session",
    events$,
    startPolling$,
    focusInput$,
  };

  return { signals, store };
}

function Wrapper({
  store,
  children,
}: {
  store: ReturnType<typeof createStore>;
  children: ReactNode;
}) {
  return <StoreProvider value={store}>{children}</StoreProvider>;
}

describe("voiceChatPanelContent", () => {
  it("shows empty state when no events exist", () => {
    const { signals, store } = makeSignals([]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    expect(screen.getByText("No conversation events yet")).toBeInTheDocument();
  });

  it("renders user speech bubble", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-1",
        seq: 1,
        source: "user",
        type: "speech",
        content: "Hello, what can you help me with?",
        createdAt: "2026-04-13T10:00:01Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    expect(
      screen.getByText("Hello, what can you help me with?"),
    ).toBeInTheDocument();
  });

  it("renders assistant (fast-brain response) bubble", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-2",
        seq: 2,
        source: "fast-brain",
        type: "response",
        content: "I can help you with many tasks.",
        createdAt: "2026-04-13T10:00:02Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    expect(
      screen.getByText("I can help you with many tasks."),
    ).toBeInTheDocument();
  });

  it("renders slow-brain thinking indicator with label and content", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-3",
        seq: 3,
        source: "slow-brain",
        type: "thinking",
        content: "Analyzing the user request",
        createdAt: "2026-04-13T10:00:03Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Analyzing the user request")).toBeInTheDocument();
  });

  it("renders slow-brain directive indicator", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-4",
        seq: 4,
        source: "slow-brain",
        type: "directive",
        content: "Be concise and direct",
        createdAt: "2026-04-13T10:00:04Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    expect(screen.getByText("Directive")).toBeInTheDocument();
    expect(screen.getByText("Be concise and direct")).toBeInTheDocument();
  });

  it("renders slow-brain observation indicator", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-5",
        seq: 5,
        source: "slow-brain",
        type: "observation",
        content: "User seems frustrated",
        createdAt: "2026-04-13T10:00:05Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    expect(screen.getByText("Observation")).toBeInTheDocument();
    expect(screen.getByText("User seems frustrated")).toBeInTheDocument();
  });

  it("renders slow-brain indicator without content section when content is null", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-6",
        seq: 6,
        source: "slow-brain",
        type: "thinking",
        content: null,
        createdAt: "2026-04-13T10:00:06Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    // Label should still render
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("does not render user bubble when content is empty whitespace", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-7",
        seq: 7,
        source: "user",
        type: "speech",
        content: "   ",
        createdAt: "2026-04-13T10:00:07Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    // Empty state is NOT shown (events list is non-empty) but bubble renders null
    expect(
      screen.queryByText("No conversation events yet"),
    ).not.toBeInTheDocument();
    // The whitespace-only content renders nothing visible
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("renders nothing visible for system-category events", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-8",
        seq: 8,
        source: "system",
        type: "status",
        content: "Connected",
        createdAt: "2026-04-13T10:00:08Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    // Not empty state (events present) but system events render null
    expect(
      screen.queryByText("No conversation events yet"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("renders multiple event types in sequence", () => {
    const { signals, store } = makeSignals([
      {
        id: "evt-a",
        seq: 1,
        source: "user",
        type: "speech",
        content: "What time is it?",
        createdAt: "2026-04-13T10:00:01Z",
      },
      {
        id: "evt-b",
        seq: 2,
        source: "slow-brain",
        type: "thinking",
        content: "Check current time",
        createdAt: "2026-04-13T10:00:02Z",
      },
      {
        id: "evt-c",
        seq: 3,
        source: "fast-brain",
        type: "response",
        content: "It is 10 AM.",
        createdAt: "2026-04-13T10:00:03Z",
      },
    ]);

    render(
      <Wrapper store={store}>
        <VoiceChatPanelContent signals={signals} />
      </Wrapper>,
    );

    expect(screen.getByText("What time is it?")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Check current time")).toBeInTheDocument();
    expect(screen.getByText("It is 10 AM.")).toBeInTheDocument();
  });
});
