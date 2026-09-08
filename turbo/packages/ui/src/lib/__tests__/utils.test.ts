import { describe, expect, it } from "vitest";
import { cn } from "../utils";

describe("design-system class merging", () => {
  it.each(["action", "badge"])(
    "keeps the foreground color when applying the %s font token",
    (token) => {
      expect(cn("text-sm text-primary-foreground", `text-${token}`)).toBe(
        `text-primary-foreground text-${token}`,
      );
      expect(cn(`text-${token}`, "text-brand-text")).toBe(
        `text-${token} text-brand-text`,
      );
    },
  );

  it("allows callers to override custom font sizes without changing colors", () => {
    expect(cn("text-action text-primary-foreground", "text-lg")).toBe(
      "text-primary-foreground text-lg",
    );
    expect(cn("text-sm hover:text-muted-foreground", "hover:text-action")).toBe(
      "text-sm hover:text-muted-foreground hover:text-action",
    );
  });
});
