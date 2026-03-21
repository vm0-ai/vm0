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

function subscribeToThemeChanges(callback: () => void): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener("storage", callback);
  mql.addEventListener("change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    mql.removeEventListener("change", callback);
  };
}

function getServerThemeSnapshot(): Theme {
  return "dark";
}

function applyTheme(newTheme: Theme) {
  localStorage.setItem("theme", newTheme);
  document.documentElement.setAttribute("data-theme", newTheme);
  // localStorage.setItem doesn't fire storage events in the same tab,
  // so dispatch manually for cross-tab sync
  window.dispatchEvent(new Event("storage"));
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  // useSyncExternalStore reads the theme from localStorage/matchMedia on the
  // client, and returns "dark" on the server to match the HTML default.
  // React handles the server-to-client transition internally, avoiding the
  // need for a useState + useEffect mount pattern that violates
  // react-hooks/set-state-in-effect.
  const theme = useSyncExternalStore(
    subscribeToThemeChanges,
    resolveClientTheme,
    getServerThemeSnapshot,
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
