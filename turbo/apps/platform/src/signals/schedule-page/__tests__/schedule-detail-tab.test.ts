import { describe, expect, it } from "vitest";
import { mockLocation, mockReplaceState } from "../../location.ts";
import {
  scheduleDetailTab$,
  setScheduleDetailTab$,
  initScheduleDetailTab$,
} from "../schedule-detail-tab.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();

describe("schedule-detail-tab", () => {
  describe("initScheduleDetailTab$", () => {
    it("defaults to settings when URL has no tab param", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules/abc", search: "" }, signal);

      store.set(initScheduleDetailTab$);

      expect(store.get(scheduleDetailTab$)).toBe("settings");
    });

    it("reads tab from URL search params", () => {
      const { store, signal } = context;
      mockLocation(
        { pathname: "/schedules/abc", search: "?tab=history" },
        signal,
      );

      store.set(initScheduleDetailTab$);

      expect(store.get(scheduleDetailTab$)).toBe("history");
    });

    it("reads instructions tab from URL", () => {
      const { store, signal } = context;
      mockLocation(
        { pathname: "/schedules/abc", search: "?tab=instructions" },
        signal,
      );

      store.set(initScheduleDetailTab$);

      expect(store.get(scheduleDetailTab$)).toBe("instructions");
    });

    it("falls back to settings for invalid tab value", () => {
      const { store, signal } = context;
      mockLocation(
        { pathname: "/schedules/abc", search: "?tab=bogus" },
        signal,
      );

      store.set(initScheduleDetailTab$);

      expect(store.get(scheduleDetailTab$)).toBe("settings");
    });
  });

  describe("setScheduleDetailTab$", () => {
    it("updates tab state", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules/abc", search: "" }, signal);

      store.set(setScheduleDetailTab$, "history");

      expect(store.get(scheduleDetailTab$)).toBe("history");
    });

    it("writes tab to URL via replaceState", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/schedules/abc", search: "" }, signal);

      const calls: string[] = [];
      mockReplaceState(
        ((_data: unknown, _unused: string, url?: string | URL | null) => {
          if (typeof url === "string") {
            calls.push(url);
          }
        }) as typeof window.history.replaceState,
        signal,
      );

      store.set(setScheduleDetailTab$, "history");

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("tab=history");
    });

    it("removes tab param from URL when switching to default (settings)", () => {
      const { store, signal } = context;
      mockLocation(
        { pathname: "/schedules/abc", search: "?tab=history" },
        signal,
      );

      const calls: string[] = [];
      mockReplaceState(
        ((_data: unknown, _unused: string, url?: string | URL | null) => {
          if (typeof url === "string") {
            calls.push(url);
          }
        }) as typeof window.history.replaceState,
        signal,
      );

      store.set(setScheduleDetailTab$, "settings");

      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("tab=");
    });
  });
});
