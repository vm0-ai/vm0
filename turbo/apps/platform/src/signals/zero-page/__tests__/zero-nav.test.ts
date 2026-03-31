import { command } from "ccstate";
import { describe, expect, it, vi } from "vitest";
import { mockLocation } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createPushStateMock } from "../../../__tests__/page-helper.ts";
import {
  zeroActiveId$,
  chatThreadId$,
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

    it("should resolve unknown tab /meet to 'not-found'", () => {
      mockLocation({ pathname: "/meet", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("not-found");
    });

    it("should resolve /schedule to 'schedule'", () => {
      mockLocation({ pathname: "/schedule", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });

    it("should resolve /schedule/:id to 'schedule'", () => {
      mockLocation(
        {
          pathname: "/schedule/2f3cad0c-cf1a-4b82-a104-529c9c70a360",
          search: "",
        },
        context.signal,
      );
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

    it("should resolve unknown path to 'not-found'", () => {
      mockLocation({ pathname: "/invalid", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("not-found");
    });

    it("should not resolve unknown path /scheduled to chat (bug #5869)", () => {
      mockLocation({ pathname: "/scheduled", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).not.toBe("chat");
      expect(context.store.get(zeroActiveId$)).toBe("not-found");
    });

    it("should not resolve unknown path /foo to chat (bug #5869)", () => {
      mockLocation({ pathname: "/foo", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).not.toBe("chat");
      expect(context.store.get(zeroActiveId$)).toBe("not-found");
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
          { path: "/talk/:agentId", setup: noop$ },
          { path: "/chat/:chatThreadId", setup: noop$ },
          { path: "{/*path}", setup: noop$ },
        ],
        context.signal,
      );
    }

    it("should return null for /", async () => {
      await setupRoutes("/");
      expect(context.store.get(chatThreadId$)).toBeNull();
    });

    it("should return null for /talk/:agentId", async () => {
      await setupRoutes("/talk/my-agent");
      expect(context.store.get(chatThreadId$)).toBeNull();
    });

    it("should extract thread ID from /chat/:chatThreadId", async () => {
      await setupRoutes("/chat/thread-abc-123");
      expect(context.store.get(chatThreadId$)).toBe("thread-abc-123");
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
      const noop$ = command(() => {
        return void 0;
      });
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/schedule", setup: noop$ },
          { path: "{/*path}", setup: noop$ },
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
      const noop$ = command(() => {
        return void 0;
      });
      await context.store.set(
        initRoutes$,
        [
          { path: "/", setup: noop$ },
          { path: "/preferences", setup: noop$ },
          { path: "{/*path}", setup: noop$ },
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
