import { describe, it, expect, beforeEach } from "vitest";
import { testContext } from "./test-helpers.ts";
import { sidebarCollapsed$, toggleSidebar$, initSidebar$ } from "../sidebar.ts";

const context = testContext();

describe("sidebar signals", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("sidebarCollapsed$", () => {
    it("should default to false (expanded)", () => {
      const collapsed = context.store.get(sidebarCollapsed$);
      expect(collapsed).toBeFalsy();
    });
  });

  describe("toggleSidebar$", () => {
    it("should toggle from false to true", () => {
      expect(context.store.get(sidebarCollapsed$)).toBeFalsy();

      context.store.set(toggleSidebar$);

      expect(context.store.get(sidebarCollapsed$)).toBeTruthy();
    });

    it("should toggle from true to false", () => {
      context.store.set(toggleSidebar$); // false -> true
      expect(context.store.get(sidebarCollapsed$)).toBeTruthy();

      context.store.set(toggleSidebar$); // true -> false

      expect(context.store.get(sidebarCollapsed$)).toBeFalsy();
    });

    it("should persist state to localStorage", () => {
      context.store.set(toggleSidebar$);

      expect(localStorage.getItem("sidebar-collapsed")).toBe("true");

      context.store.set(toggleSidebar$);

      expect(localStorage.getItem("sidebar-collapsed")).toBe("false");
    });
  });

  describe("initSidebar$", () => {
    it("should initialize from localStorage when value is true", () => {
      localStorage.setItem("sidebar-collapsed", "true");

      context.store.set(initSidebar$);

      expect(context.store.get(sidebarCollapsed$)).toBeTruthy();
    });

    it("should default to false when localStorage is empty", () => {
      context.store.set(initSidebar$);

      expect(context.store.get(sidebarCollapsed$)).toBeFalsy();
    });

    it("should default to false when localStorage has invalid value", () => {
      localStorage.setItem("sidebar-collapsed", "invalid");

      context.store.set(initSidebar$);

      expect(context.store.get(sidebarCollapsed$)).toBeFalsy();
    });
  });
});
