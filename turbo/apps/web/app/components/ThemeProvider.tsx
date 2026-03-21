"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

function resolveClientTheme(): Theme {
  const saved = localStorage.getItem("theme") as Theme | null;
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(newTheme: Theme) {
  localStorage.setItem("theme", newTheme);
  document.documentElement.setAttribute("data-theme", newTheme);
  // localStorage.setItem doesn't fire storage events in the same tab,
  // so dispatch manually for cross-tab sync
  window.dispatchEvent(new Event("storage"));
}

/** Subscribe to storage and OS color-scheme changes. */
function subscribeToTheme(callback: () => void): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener("storage", callback);
  mql.addEventListener("change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    mql.removeEventListener("change", callback);
  };
}

function getThemeSnapshot(): Theme {
  return resolveClientTheme();
}

function getServerSnapshot(): Theme {
  return "dark";
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  // useSyncExternalStore reads the client theme synchronously on mount,
  // eliminating the need for a post-mount setState inside useEffect.
  // Server snapshot returns "dark" to match the HTML default data-theme="dark".
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerSnapshot,
  );

  // Apply data-theme attribute whenever theme changes
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    applyTheme(newTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    const current = resolveClientTheme();
    const newTheme = current === "dark" ? "light" : "dark";
    applyTheme(newTheme);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
