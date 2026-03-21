// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../ThemeProvider";

function ThemeDisplay() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button data-testid="toggle-btn" onClick={toggleTheme}>
        Toggle
      </button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  // Default to light color scheme (no dark preference)
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" ? false : false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

describe("ThemeProvider and ThemeToggle", () => {
  it("should resolve to light theme after hydration when system prefers light", () => {
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>,
    );

    // After hydration (useEffect runs), theme should be "light" from system preference
    expect(screen.getByTestId("theme-value").textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("should toggle theme from light to dark when button is clicked", () => {
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>,
    );

    // Initially light
    expect(screen.getByTestId("theme-value").textContent).toBe("light");

    // Click toggle
    fireEvent.click(screen.getByTestId("toggle-btn"));

    // Should now be dark
    expect(screen.getByTestId("theme-value").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("should toggle theme from dark to light when button is clicked", () => {
    localStorage.setItem("theme", "dark");

    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>,
    );

    // Initially dark from localStorage
    expect(screen.getByTestId("theme-value").textContent).toBe("dark");

    // Click toggle
    fireEvent.click(screen.getByTestId("toggle-btn"));

    // Should now be light
    expect(screen.getByTestId("theme-value").textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("should apply data-theme attribute on mount", () => {
    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>,
    );

    // data-theme should be set after hydration
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("should read persisted theme from localStorage", () => {
    localStorage.setItem("theme", "dark");

    render(
      <ThemeProvider>
        <ThemeDisplay />
      </ThemeProvider>,
    );

    expect(screen.getByTestId("theme-value").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
