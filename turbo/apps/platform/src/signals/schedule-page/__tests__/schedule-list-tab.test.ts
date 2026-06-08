import { describe, expect, it } from "vitest";
import { mockLocation, mockReplaceState } from "../../location.ts";
import {
  initScheduleListTab$,
  scheduleListTab$,
  setScheduleListTab$,
} from "../schedule-list-tab.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();

describe("schedule-list-tab", () => {
  describe("initScheduleListTab$", () => {
    it("defaults to calendar when URL has no tab param", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "" }, signal);

      store.set(initScheduleListTab$);

      expect(store.get(scheduleListTab$)).toBe("calendar");
    });

    it("reads list tab from URL search params", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "?tab=list" }, signal);

      store.set(initScheduleListTab$);

      expect(store.get(scheduleListTab$)).toBe("list");
    });

    it("falls back to calendar for invalid tab value", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "?tab=bogus" }, signal);

      store.set(initScheduleListTab$);

      expect(store.get(scheduleListTab$)).toBe("calendar");
    });

    it("falls back to calendar for removed history tab value", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "?tab=history" }, signal);

      store.set(initScheduleListTab$);

      expect(store.get(scheduleListTab$)).toBe("calendar");
    });
  });

  describe("setScheduleListTab$", () => {
    it("updates tab state", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "" }, signal);

      store.set(setScheduleListTab$, "calendar");

      expect(store.get(scheduleListTab$)).toBe("calendar");
    });

    it("writes tab to URL via replaceState when non-default", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "" }, signal);

      const calls: string[] = [];
      mockReplaceState(
        ((_data: unknown, _unused: string, url?: string | URL | null) => {
          if (typeof url === "string") {
            calls.push(url);
          }
        }) as typeof window.history.replaceState,
        signal,
      );

      store.set(setScheduleListTab$, "list");

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("tab=list");
    });

    it("removes tab param from URL when switching back to default (calendar)", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules", search: "?tab=list" }, signal);

      const calls: string[] = [];
      mockReplaceState(
        ((_data: unknown, _unused: string, url?: string | URL | null) => {
          if (typeof url === "string") {
            calls.push(url);
          }
        }) as typeof window.history.replaceState,
        signal,
      );

      store.set(setScheduleListTab$, "calendar");

      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("tab=");
    });
  });
});
