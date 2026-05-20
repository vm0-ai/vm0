import { command } from "ccstate";
import { describe, expect, it } from "vitest";
import { mockLocation } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createPushStateMock } from "../../../__tests__/page-helper.ts";
import {
  zeroShowAboutPage$,
  setZeroShowAboutPage$,
  sidebarOff$,
  toggleSidebarOff$,
  sidebarExpanded$,
  setSidebarExpanded$,
  handleZeroNavSelect$,
  handleZeroAccountAction$,
} from "../zero-nav.ts";
import { currentChatThreadId$ } from "../../agent-chat.ts";
import { activeRoute$ } from "../../active-route.ts";
import { setRootSignal$ } from "../../root-signal.ts";
import { initRoutes$ } from "../../route.ts";

const context = testContext();

describe("zero-nav", () => {
  describe("activeRoute$", () => {
    it("should resolve / to 'home'", () => {
      mockLocation({ pathname: "/", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBe("home");
    });

    it("should resolve unknown path to null", () => {
      mockLocation({ pathname: "/meet", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBeNull();
    });

    it("should resolve /schedules to 'schedules'", () => {
      mockLocation({ pathname: "/schedules", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBe("schedules");
    });

    it("should resolve /agents to 'agents'", () => {
      mockLocation({ pathname: "/agents", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBe("agents");
    });

    it("should resolve /activities to 'activities'", () => {
      mockLocation({ pathname: "/activities", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBe("activities");
    });

    it("should resolve /local-agents to 'desktopLocalAgents'", () => {
      mockLocation({ pathname: "/local-agents", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBe("desktopLocalAgents");
    });

    it("should resolve /computer-use to 'desktopComputerUse'", () => {
      mockLocation({ pathname: "/computer-use", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBe("desktopComputerUse");
    });

    it("should resolve /works to 'works'", () => {
      mockLocation({ pathname: "/works", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBe("works");
    });

    it("should resolve /settings to 'settings'", () => {
      mockLocation({ pathname: "/settings", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBe("settings");
    });

    it("should resolve unknown path /invalid to null", () => {
      mockLocation({ pathname: "/invalid", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBeNull();
    });

    it("should not resolve unknown path /scheduled", () => {
      mockLocation({ pathname: "/scheduled", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBeNull();
    });

    it("should not resolve unknown path /foo", () => {
      mockLocation({ pathname: "/foo", search: "" }, context.signal);
      expect(context.store.get(activeRoute$)).toBeNull();
    });
  });

  describe("activeRoute$ with /agents/:id/chat", () => {
    it("should resolve /agents/agent-name/chat to 'agentChat'", () => {
      mockLocation(
        { pathname: "/agents/agent-name/chat", search: "" },
        context.signal,
      );
      expect(context.store.get(activeRoute$)).toBe("agentChat");
    });
  });

  describe("chatThreadId$", () => {
    async function setupRoutes(pathname: string) {
      context.store.set(setRootSignal$, context.signal);
      createPushStateMock(context.signal);
      mockLocation({ pathname, search: "" }, context.signal);
      const noop$ = command(() => {
        return void 0;
      });
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/agents/:id/chat", setup: noop$ },
          { path: "/chats/:threadId", setup: noop$ },
          { path: "{/*path}", setup: noop$ },
        ],
        context.signal,
      );
    }

    it("should return null for /", async () => {
      await setupRoutes("/");
      expect(context.store.get(currentChatThreadId$)).toBeNull();
    });

    it("should return null for /agents/:id/chat", async () => {
      await setupRoutes("/agents/my-agent/chat");
      expect(context.store.get(currentChatThreadId$)).toBeNull();
    });

    it("should extract thread ID from /chats/:threadId", async () => {
      await setupRoutes("/chats/thread-abc-123");
      expect(context.store.get(currentChatThreadId$)).toBe("thread-abc-123");
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

  describe("sidebarOff$", () => {
    it("should default to false", () => {
      expect(context.store.get(sidebarOff$)).toBeFalsy();
    });

    it("should toggle via toggleSidebarOff$", () => {
      context.store.set(toggleSidebarOff$);
      expect(context.store.get(sidebarOff$)).toBeTruthy();

      context.store.set(toggleSidebarOff$);
      expect(context.store.get(sidebarOff$)).toBeFalsy();
    });
  });

  describe("sidebarExpanded$", () => {
    it("should default to false", () => {
      expect(context.store.get(sidebarExpanded$)).toBeFalsy();
    });

    it("should set via setSidebarExpanded$", () => {
      context.store.set(setSidebarExpanded$, true);
      expect(context.store.get(sidebarExpanded$)).toBeTruthy();

      context.store.set(setSidebarExpanded$, false);
      expect(context.store.get(sidebarExpanded$)).toBeFalsy();
    });
  });

  describe("handleZeroNavSelect$", () => {
    it("should navigate to the selected tab and close about page", async () => {
      const pushStateMock = await setupNav();

      context.store.set(setZeroShowAboutPage$, true);
      context.store.set(handleZeroNavSelect$, "schedules", context.signal);

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/schedules");
      expect(context.store.get(activeRoute$)).toBe("schedules");
      expect(context.store.get(zeroShowAboutPage$)).toBeFalsy();
    });

    async function setupNav() {
      context.store.set(setRootSignal$, context.signal);
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);
      const noop$ = command(() => {
        return void 0;
      });
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/schedules", setup: noop$ },
          { path: "{/*path}", setup: noop$ },
        ],
        context.signal,
      );
      return pushStateMock;
    }
  });

  describe("handleZeroAccountAction$", () => {
    it("should navigate to settings for 'preferences' action", async () => {
      context.store.set(setRootSignal$, context.signal);
      createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);
      const noop$ = command(() => {
        return void 0;
      });
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/settings", setup: noop$ },
          { path: "{/*path}", setup: noop$ },
        ],
        context.signal,
      );

      context.store.set(handleZeroAccountAction$, "preferences");

      expect(context.store.get(activeRoute$)).toBe("settings");
    });

    it("should navigate to usage for 'usage' action", async () => {
      context.store.set(setRootSignal$, context.signal);
      createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);
      const noop$ = command(() => {
        return void 0;
      });
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/usage", setup: noop$ },
          { path: "{/*path}", setup: noop$ },
        ],
        context.signal,
      );

      context.store.set(handleZeroAccountAction$, "usage");

      expect(context.store.get(activeRoute$)).toBe("usage");
    });

    it("should navigate to lab for 'lab' action", async () => {
      context.store.set(setRootSignal$, context.signal);
      createPushStateMock(context.signal);
      mockLocation({ pathname: "/", search: "" }, context.signal);
      const noop$ = command(() => {
        return void 0;
      });
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/_/lab", setup: noop$ },
          { path: "{/*path}", setup: noop$ },
        ],
        context.signal,
      );

      context.store.set(handleZeroAccountAction$, "lab");

      expect(context.store.get(activeRoute$)).toBe("lab");
    });

    it("should do nothing for 'signout' action", () => {
      mockLocation({ pathname: "/schedules", search: "" }, context.signal);

      context.store.set(handleZeroAccountAction$, "signout");

      expect(context.store.get(activeRoute$)).toBe("schedules");
    });

    it("should do nothing for 'manage' action", () => {
      mockLocation({ pathname: "/schedules", search: "" }, context.signal);

      context.store.set(handleZeroAccountAction$, "manage");

      expect(context.store.get(activeRoute$)).toBe("schedules");
    });
  });
});
