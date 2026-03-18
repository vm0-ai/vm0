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
} from "../zero-nav.ts";

const context = testContext();

describe("zero-nav", () => {
  describe("zeroActiveId$", () => {
    it("should default to 'chat' for /", () => {
      mockLocation({ pathname: "/", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should resolve /chat to 'chat'", () => {
      mockLocation({ pathname: "/chat", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should resolve unknown tab /meet to default 'chat'", () => {
      mockLocation({ pathname: "/meet", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should resolve /schedule to 'schedule'", () => {
      mockLocation({ pathname: "/schedule", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });

    it("should resolve /team to 'team'", () => {
      mockLocation({ pathname: "/team", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("team");
    });

    it("should resolve /activity to 'activity'", () => {
      mockLocation({ pathname: "/activity", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("activity");
    });

    it("should resolve /works to 'works'", () => {
      mockLocation({ pathname: "/works", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("works");
    });

    it("should resolve /preferences to 'preferences'", () => {
      mockLocation({ pathname: "/preferences", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("preferences");
    });

    it("should fall back to 'chat' for invalid tab", () => {
      mockLocation({ pathname: "/invalid", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should resolve /settings to 'settings'", () => {
      mockLocation({ pathname: "/settings", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("settings");
    });
  });

  describe("setZeroActiveId$", () => {
    it("should navigate to / for 'chat'", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);

      context.store.set(setZeroActiveId$, "chat");

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/");
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should navigate to /schedule for 'schedule'", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);

      context.store.set(setZeroActiveId$, "schedule");

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/schedule");
      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });
  });

  describe("zeroActiveId$ with /talk/:name", () => {
    it("should resolve /talk/agent-name to 'chat'", () => {
      mockLocation(
        { pathname: "/talk/agent-name", search: "" },
        context.signal,
      );
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });
  });

  describe("zeroChatAgentName$", () => {
    it("should return null for /", () => {
      mockLocation({ pathname: "/", search: "" }, context.signal);
      expect(context.store.get(zeroChatAgentName$)).toBeNull();
    });

    it("should return null for /chat", () => {
      mockLocation({ pathname: "/chat", search: "" }, context.signal);
      expect(context.store.get(zeroChatAgentName$)).toBeNull();
    });

    it("should extract agent name from /talk/:name", () => {
      mockLocation({ pathname: "/talk/my-agent", search: "" }, context.signal);
      expect(context.store.get(zeroChatAgentName$)).toBe("my-agent");
    });

    it("should decode URI-encoded agent names", () => {
      mockLocation(
        { pathname: "/talk/agent%20with%20spaces", search: "" },
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
});
