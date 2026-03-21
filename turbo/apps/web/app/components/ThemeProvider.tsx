"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
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

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  // Start with "dark" to match the server render and the HTML default data-theme="dark".
  // The inline script in layout.tsx prevents FOUC by setting the correct data-theme
  // before paint. After hydration, useEffect reads the real client theme.
  const [theme, setThemeState] = useState<Theme>("dark");

  // After mount, sync state with the actual client theme
  useEffect(() => {
    setThemeState(resolveClientTheme());
  }, []);

  // Apply data-theme attribute whenever theme changes
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Subscribe to external theme changes (storage events, OS preference changes)
  useEffect(() => {
    const onStorage = () => {
      setThemeState(resolveClientTheme());
    };
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => {
      setThemeState(resolveClientTheme());
    };
    window.addEventListener("storage", onStorage);
    mql.addEventListener("change", onMediaChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      mql.removeEventListener("change", onMediaChange);
    };
  }, []);

  const setTheme = useCallback((newTheme: Theme) => {
    applyTheme(newTheme);
    setThemeState(newTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const newTheme = current === "dark" ? "light" : "dark";
      applyTheme(newTheme);
      return newTheme;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
