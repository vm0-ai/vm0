import { command } from "ccstate";
import { describe, expect, it, vi } from "vitest";
import { mockLocation } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createPushStateMock } from "../../../__tests__/page-helper.ts";
import {
  zeroActiveId$,
  setZeroActiveId$,
  zeroChatAgentName$,
  zeroChatAgentId$,
  setZeroChatAgent$,
  zeroAvatarIndex$,
  cycleZeroAvatar$,
  zeroShowAboutPage$,
  setZeroShowAboutPage$,
  zeroSidebarCollapsed$,
  setZeroSidebarCollapsed$,
  initSidebarCollapsed$,
  handleZeroNavSelect$,
  handleZeroAccountAction$,
} from "../zero-nav.ts";
import { setRootSignal$ } from "../../root-signal.ts";
import { initRoutes$ } from "../../route.ts";

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
    async function setupNav() {
      context.store.set(setRootSignal$, context.signal);
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);
      const noop$ = command(() => void 0);
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/:tab", setup: noop$ },
        ],
        context.signal,
      );
      return pushStateMock;
    }

    it("should navigate to / for 'chat'", async () => {
      const pushStateMock = await setupNav();

      context.store.set(setZeroActiveId$, "chat");

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/");
      expect(context.store.get(zeroActiveId$)).toBe("chat");
    });

    it("should navigate to /schedule for 'schedule'", async () => {
      const pushStateMock = await setupNav();

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

  describe("zeroAvatarIndex$ and cycleZeroAvatar$", () => {
    it("should default to 0", () => {
      expect(context.store.get(zeroAvatarIndex$)).toBe(0);
    });

    it("should advance to the next index", () => {
      context.store.set(cycleZeroAvatar$, 5);
      expect(context.store.get(zeroAvatarIndex$)).toBe(1);
    });

    it("should wrap around when reaching the end", () => {
      context.store.set(cycleZeroAvatar$, 3);
      context.store.set(cycleZeroAvatar$, 3);
      context.store.set(cycleZeroAvatar$, 3);
      expect(context.store.get(zeroAvatarIndex$)).toBe(0);
    });
  });

  describe("zeroShowAboutPage$ and setZeroShowAboutPage$", () => {
    it("should default to false", () => {
      expect(context.store.get(zeroShowAboutPage$)).toBeFalsy();
    });

    it("should set to true", () => {
      context.store.set(setZeroShowAboutPage$, true);
      expect(context.store.get(zeroShowAboutPage$)).toBeTruthy();
    });

    it("should set back to false", () => {
      context.store.set(setZeroShowAboutPage$, true);
      context.store.set(setZeroShowAboutPage$, false);
      expect(context.store.get(zeroShowAboutPage$)).toBeFalsy();
    });
  });

  describe("zeroSidebarCollapsed$", () => {
    it("should default to false", () => {
      expect(context.store.get(zeroSidebarCollapsed$)).toBeFalsy();
    });

    it("should toggle via setZeroSidebarCollapsed$", () => {
      context.store.set(setZeroSidebarCollapsed$, true);
      expect(context.store.get(zeroSidebarCollapsed$)).toBeTruthy();

      context.store.set(setZeroSidebarCollapsed$, false);
      expect(context.store.get(zeroSidebarCollapsed$)).toBeFalsy();
    });

    it("should initialize as collapsed on mobile viewport", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(500);

      context.store.set(initSidebarCollapsed$);
      expect(context.store.get(zeroSidebarCollapsed$)).toBeTruthy();

      vi.restoreAllMocks();
    });

    it("should initialize as expanded on desktop viewport", () => {
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);

      context.store.set(initSidebarCollapsed$);
      expect(context.store.get(zeroSidebarCollapsed$)).toBeFalsy();

      vi.restoreAllMocks();
    });
  });

  describe("handleZeroNavSelect$", () => {
    it("should navigate to the selected tab and close about page", async () => {
      const pushStateMock = await setupNav();

      context.store.set(setZeroShowAboutPage$, true);
      context.store.set(handleZeroNavSelect$, "schedule");

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/schedule");
      expect(context.store.get(zeroActiveId$)).toBe("schedule");
      expect(context.store.get(zeroShowAboutPage$)).toBeFalsy();
    });

    async function setupNav() {
      context.store.set(setRootSignal$, context.signal);
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);
      const noop$ = command(() => void 0);
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/:tab", setup: noop$ },
        ],
        context.signal,
      );
      return pushStateMock;
    }
  });

  describe("handleZeroAccountAction$", () => {
    it("should navigate to preferences for 'preferences' action", async () => {
      context.store.set(setRootSignal$, context.signal);
      createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);
      const noop$ = command(() => void 0);
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/:tab", setup: noop$ },
        ],
        context.signal,
      );

      context.store.set(handleZeroAccountAction$, "preferences");

      expect(context.store.get(zeroActiveId$)).toBe("preferences");
    });

    it("should do nothing for 'signout' action", () => {
      mockLocation({ pathname: "/schedule", search: "" }, context.signal);

      context.store.set(handleZeroAccountAction$, "signout");

      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });

    it("should do nothing for 'manage' action", () => {
      mockLocation({ pathname: "/schedule", search: "" }, context.signal);

      context.store.set(handleZeroAccountAction$, "manage");

      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });
  });
});
