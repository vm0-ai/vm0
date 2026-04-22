/**
 * Tests for VoiceChatEventItem rendering of fast-brain/request-slow-brain
 * events and the system-event hidden invariant.
 *
 * See: turbo/apps/platform/src/views/voice-chat/voice-chat-bubbles.tsx
 */

import type { ContextEvent } from "@vm0/core";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VoiceChatEventItem } from "../voice-chat-bubbles.tsx";

function makeEvent(partial: Partial<ContextEvent>): ContextEvent {
  return {
    id: "evt-1",
    seq: 1,
    source: "system",
    type: "session-start",
    content: null,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe("voice-chat event item - fast-brain request-slow-brain", () => {
  it("renders a Delegated to slow-brain indicator with task content", () => {
    const event = makeEvent({
      source: "fast-brain",
      type: "request-slow-brain",
      content: "check PR #123",
    });

    render(<VoiceChatEventItem event={event} />);

    expect(screen.getByText("Delegated to slow-brain")).toBeInTheDocument();
    expect(screen.getByText("check PR #123")).toBeInTheDocument();
  });

  it("renders the label without content details when content is null", () => {
    const event = makeEvent({
      source: "fast-brain",
      type: "request-slow-brain",
      content: null,
    });

    const { container } = render(<VoiceChatEventItem event={event} />);

    expect(screen.getByText("Delegated to slow-brain")).toBeInTheDocument();
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("voice-chat event item - system events stay hidden", () => {
  it("renders nothing for a session-start event", () => {
    const event = makeEvent({
      source: "system",
      type: "session-start",
      content: null,
    });

    const { container } = render(<VoiceChatEventItem event={event} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for task-dispatched and task-completed events", () => {
    for (const type of ["task-dispatched", "task-completed"] as const) {
      const event = makeEvent({
        source: "system",
        type,
        content: "irrelevant",
      });
      const { container, unmount } = render(
        <VoiceChatEventItem event={event} />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
