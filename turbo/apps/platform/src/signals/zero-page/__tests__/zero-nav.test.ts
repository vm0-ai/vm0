import { describe, expect, it } from "vitest";
import { mockLocation } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createPushStateMock } from "../../../__tests__/page-helper.ts";
import { zeroActiveId$, setZeroActiveId$ } from "../zero-nav.ts";

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

    it("should resolve /zero/meet to 'meet'", () => {
      mockLocation({ pathname: "/zero/meet", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("meet");
    });

    it("should resolve /zero/schedule to 'schedule'", () => {
      mockLocation({ pathname: "/zero/schedule", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });

    it("should resolve /zero/job to 'job'", () => {
      mockLocation({ pathname: "/zero/job", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("job");
    });

    it("should resolve /zero/activity to 'activity'", () => {
      mockLocation({ pathname: "/zero/activity", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("activity");
    });

    it("should resolve /zero/works to 'works'", () => {
      mockLocation({ pathname: "/zero/works", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("works");
    });

    it("should resolve /zero/account to 'account'", () => {
      mockLocation({ pathname: "/zero/account", search: "" }, context.signal);
      expect(context.store.get(zeroActiveId$)).toBe("account");
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

    it("should navigate to /zero/meet for 'meet'", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/zero", search: "" }, context.signal);

      context.store.set(setZeroActiveId$, "meet");

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/zero/meet");
      expect(context.store.get(zeroActiveId$)).toBe("meet");
    });

    it("should navigate to /zero/schedule for 'schedule'", () => {
      const pushStateMock = createPushStateMock(context.signal);
      mockLocation({ pathname: "/zero", search: "" }, context.signal);

      context.store.set(setZeroActiveId$, "schedule");

      expect(pushStateMock).toHaveBeenCalledWith({}, "", "/zero/schedule");
      expect(context.store.get(zeroActiveId$)).toBe("schedule");
    });
  });
});
