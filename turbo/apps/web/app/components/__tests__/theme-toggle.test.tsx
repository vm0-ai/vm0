// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../ThemeProvider";
import { ThemeToggle } from "../ThemeToggle";

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

function mockMatchMedia(prefersDark: boolean) {
  const listeners: Array<() => void> = [];
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => {
      return {
        matches:
          query === "(prefers-color-scheme: dark)" ? prefersDark : !prefersDark,
        addEventListener: (_event: string, cb: () => void) => {
          listeners.push(cb);
        },
        removeEventListener: (_event: string, cb: () => void) => {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
    },
    configurable: true,
    writable: true,
  });
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    mockMatchMedia(false); // default: OS prefers light
  });

  it("should toggle theme from light to dark when button is clicked", async () => {
    renderToggle();

    // After mount, theme resolves to "light" (OS preference)
    await act(() => {
      return Promise.resolve();
    });

    const button = screen.getByRole("button", {
      name: /switch to dark mode/i,
    });
    await userEvent.click(button);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("should toggle theme from dark to light when button is clicked", async () => {
    localStorage.setItem("theme", "dark");

    renderToggle();
    await act(() => {
      return Promise.resolve();
    });

    const button = screen.getByRole("button", {
      name: /switch to light mode/i,
    });
    await userEvent.click(button);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("should persist theme preference to localStorage", async () => {
    renderToggle();
    await act(() => {
      return Promise.resolve();
    });

    const button = screen.getByRole("button");
    await userEvent.click(button);

    const savedTheme = localStorage.getItem("theme");
    expect(savedTheme === "light" || savedTheme === "dark").toBe(true);
  });
});
