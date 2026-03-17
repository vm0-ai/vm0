import { describe, expect, it } from "vitest";
import { mockLocation } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createPushStateMock } from "../../../__tests__/page-helper.ts";
import {
  zeroActiveId$,
  setZeroActiveId$,
  zeroChatAgentName$,
  zeroChatAgentId$,
  setZeroChatAgent$,
  navigateFromZeroSession$,
} from "../zero-nav.ts";

const context = testContext();

describe("zero-nav", () => {
  describe("zeroActiveId$", () => {
    it("should default to 'chat' for /zero", () => {
      mockLocation({ pathname: "/zero", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should default to 'chat' for /zero/", () => {
      mockLocation({ pathname: "/zero/", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should resolve /zero/chat to 'chat'", () => {
      mockLocation({ pathname: "/zero/chat", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should resolve unknown tab /zero/meet to default 'chat'", () => {
      mockLocation({ pathname: "/zero/meet", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should resolve /zero/schedule to 'schedule'", () => {
      mockLocation({ pathname: "/zero/schedule", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });

    it("should resolve /zero/team to 'team'", () => {
      mockLocation({ pathname: "/zero/team", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("team");
    });

    it("should resolve /zero/activity to 'activity'", () => {
      mockLocation({ pathname: "/zero/activity", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("activity");
    });

    it("should resolve /zero/works to 'works'", () => {
      mockLocation({ pathname: "/zero/works", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("works");
    });

    it("should resolve /zero/preferences to 'preferences'", () => {
      mockLocation(
        { pathname: "/zero/preferences", search: "" },
        context.signal,
      );
      expect(context.store.get(zeroActiveId$)).toBe("preferences");
    });

    it("should fall back to 'chat' for invalid tab", () => {
      mockLocation({ pathname: "/zero/invalid", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should fall back to 'chat' for non-zero path", () => {
      mockLocation({ pathname: "/settings", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });
  });

  describe("setZeroActiveId$", () => {
    it("should navigate to /zero for 'chat'", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/zero", search: "" }, context.signal);

      context.store.set(setZeroActiveId$, "chat");

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/zero");
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should navigate to /zero/schedule for 'schedule'", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/zero", search: "" }, context.signal);

      context.store.set(setZeroActiveId$, "schedule");

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/zero/schedule");
      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });
  });

  describe("zeroActiveId$ with /zero/talk/:name", () => {
    it("should resolve /zero/talk/agent-name to 'chat'", () => {
      mockLocation(
        { pathname: "/zero/talk/agent-name", search: "" },
        context.signal,
      );
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });
  });

  describe("zeroChatAgentName$", () => {
    it("should return null for /zero", () => {
      mockLocation({ pathname: "/zero", search: "" }, context.signal);
      expect(context.store.get(zeroChatAgentName$)).toBeNull();
    });

    it("should return null for /zero/chat", () => {
      mockLocation({ pathname: "/zero/chat", search: "" }, context.signal);
      expect(context.store.get(zeroChatAgentName$)).toBeNull();
    });

    it("should extract agent name from /zero/talk/:name", () => {
      mockLocation(
        { pathname: "/zero/talk/my-agent", search: "" },
        context.signal,
      );
      expect(context.store.get(zeroChatAgentName$)).toBe("my-agent");
    });

    it("should decode URI-encoded agent names", () => {
      mockLocation(
        { pathname: "/zero/talk/agent%20with%20spaces", search: "" },
        context.signal,
      );
      expect(context.store.get(zeroChatAgentName$)).toBe("agent with spaces");
    });
  });

  describe("setZeroChatAgent$ and zeroChatAgentId$", () => {
    it("should set and read agent ID", () => {
      context.store.set(setZeroChatAgent$, {
        id: "agent-123",
        name: "test-agent",
      });
      expect(context.store.get(zeroChatAgentId$)).toBe("agent-123");
    });

    it("should clear agent ID when set to null", () => {
      context.store.set(setZeroChatAgent$, {
        id: "agent-123",
        name: "test-agent",
      });
      context.store.set(setZeroChatAgent$, null);
      expect(context.store.get(zeroChatAgentId$)).toBeNull();
    });
  });

  describe("navigateFromZeroSession$", () => {
    it("should navigate to /zero when no agent was selected", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation(
        { pathname: "/zero/chat/session-1", search: "" },
        context.signal,
      );

      context.store.set(setZeroChatAgent$, null);
      context.store.set(navigateFromZeroSession$);

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/zero");
    });

    it("should navigate to /zero/talk/:name when agent was selected", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation(
        { pathname: "/zero/chat/session-1", search: "" },
        context.signal,
      );

      context.store.set(setZeroChatAgent$, {
        id: "agent-123",
        name: "my-agent",
      });
      context.store.set(navigateFromZeroSession$);

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/zero/talk/my-agent");
    });

    it("should encode agent names with special characters", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation(
        { pathname: "/zero/chat/session-1", search: "" },
        context.signal,
      );

      context.store.set(setZeroChatAgent$, {
        id: "agent-456",
        name: "agent with spaces",
      });
      context.store.set(navigateFromZeroSession$);

      expect(pushStateMock).toHaveBeenCalledWith(
        {},
        "",
        "/zero/talk/agent%20with%20spaces",
      );
    });
  });
});
