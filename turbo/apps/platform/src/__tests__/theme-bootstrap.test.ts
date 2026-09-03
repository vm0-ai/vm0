import { describe, expect, it } from "vitest";

import INDEX_HTML from "../../index.html?raw";
import {
  OKOU_THEME_COOKIE_NAME,
  decodeOkouThemePreference,
  encodeOkouThemePreference,
  readOkouThemePreferenceCookie,
  serializeOkouThemePreferenceCookie,
} from "../lib/okou-theme-cookie.ts";

function themeBootstrapScript(): string {
  const sourceDocument = new DOMParser().parseFromString(
    INDEX_HTML,
    "text/html",
  );
  const script = sourceDocument.getElementById("theme-bootstrap");
  if (!(script instanceof HTMLScriptElement)) {
    throw new Error("Missing #theme-bootstrap in the Platform index");
  }
  return script.textContent ?? "";
}

function runThemeBootstrap({
  brandName = "Okou",
  cookie = "",
  cookieBlocked = false,
  path = "/",
  savedTheme = null,
  storageBlocked = false,
  systemDark = false,
}: {
  brandName?: "Okou" | "VM0";
  cookie?: string;
  cookieBlocked?: boolean;
  path?: string;
  savedTheme?: string | null;
  storageBlocked?: boolean;
  systemDark?: boolean;
} = {}) {
  const dataset: Record<string, string> = { appBrandName: brandName };
  const classes = new Set<string>();
  const document = {
    documentElement: {
      dataset,
      classList: {
        add(name: string) {
          classes.add(name);
        },
        toggle(name: string, enabled: boolean) {
          if (enabled) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
      },
    },
  } as {
    cookie: string;
    documentElement: {
      classList: {
        add(name: string): void;
        toggle(name: string, enabled: boolean): void;
      };
      dataset: Record<string, string>;
    };
  };
  Object.defineProperty(document, "cookie", {
    get() {
      if (cookieBlocked) {
        throw new Error("Cookies blocked");
      }
      return cookie;
    },
  });

  const executeBootstrap = new Function(
    "document",
    "localStorage",
    "window",
    `${themeBootstrapScript()}\n//# sourceURL=platform-theme-bootstrap-test.js`,
  ) as (document: object, localStorage: object, window: object) => void;
  executeBootstrap(
    document,
    {
      getItem: () => {
        if (storageBlocked) {
          throw new Error("Storage blocked");
        }
        return savedTheme;
      },
    },
    {
      location: { pathname: path },
      matchMedia: () => ({ matches: systemDark }),
    },
  );

  return { classes, dataset };
}

describe("platform theme bootstrap", () => {
  it("runs before critical styles so the first paint uses the resolved theme", () => {
    expect(INDEX_HTML.indexOf('id="theme-bootstrap"')).toBeGreaterThan(-1);
    expect(
      INDEX_HTML.indexOf('id="app-bootstrap-critical-styles"'),
    ).toBeGreaterThan(-1);
    expect(INDEX_HTML.indexOf('id="theme-bootstrap"')).toBeLessThan(
      INDEX_HTML.indexOf('id="app-bootstrap-critical-styles"'),
    );
  });

  it.each(["/", "/sign-in", "/sign-up"])(
    "applies a shared dark preference on %s before application startup",
    (path) => {
      const { classes, dataset } = runThemeBootstrap({
        cookie: `${OKOU_THEME_COOKIE_NAME}=v1.dark`,
        path,
        savedTheme: "light",
      });

      expect(dataset.theme).toBe("dark");
      expect(classes.has("dark")).toBeTruthy();
    },
  );

  it.each([
    ["light", true, "light", false],
    ["dark", false, "dark", true],
    ["system", false, "light", false],
    ["system", true, "dark", true],
  ] as const)(
    "resolves shared %s with system-dark=%s to %s",
    (preference, systemDark, expectedTheme, expectedDarkClass) => {
      const { classes, dataset } = runThemeBootstrap({
        cookie: `${OKOU_THEME_COOKIE_NAME}=v1.${preference}`,
        savedTheme: preference === "dark" ? "light" : "dark",
        systemDark,
      });

      expect(dataset.theme).toBe(expectedTheme);
      expect(classes.has("dark")).toBe(expectedDarkClass);
    },
  );

  it.each(["v0.dark", "v1.invalid", "dark", ""])(
    "falls back from malformed shared value %s to existing app storage",
    (value) => {
      const { classes, dataset } = runThemeBootstrap({
        cookie: `${OKOU_THEME_COOKIE_NAME}=${value}`,
        savedTheme: "light",
        systemDark: true,
      });

      expect(dataset.theme).toBe("light");
      expect(classes.has("dark")).toBeFalsy();
    },
  );

  it("falls back to the system when cookie and storage access are blocked", () => {
    const { classes, dataset } = runThemeBootstrap({
      cookieBlocked: true,
      storageBlocked: true,
      systemDark: true,
    });

    expect(dataset.theme).toBe("dark");
    expect(classes.has("dark")).toBeTruthy();
  });

  it("never reads the Okou cookie for the VM0 app", () => {
    const { classes, dataset } = runThemeBootstrap({
      brandName: "VM0",
      cookie: `${OKOU_THEME_COOKIE_NAME}=v1.dark`,
      savedTheme: "light",
      systemDark: true,
    });

    expect(dataset.theme).toBe("light");
    expect(classes.has("dark")).toBeFalsy();
  });

  it("encodes only versioned semantic values on Okou parent domains", () => {
    expect(
      (["light", "dark", "system"] as const).map((preference) => {
        return decodeOkouThemePreference(encodeOkouThemePreference(preference));
      }),
    ).toStrictEqual(["light", "dark", "system"]);
    expect(decodeOkouThemePreference("v0.dark")).toBeNull();
    expect(decodeOkouThemePreference("v1.blue")).toBeNull();
    expect(serializeOkouThemePreferenceCookie("dark", "app.okou.ai")).toBe(
      `${OKOU_THEME_COOKIE_NAME}=v1.dark; Domain=.okou.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(
      serializeOkouThemePreferenceCookie("system", "pr-123-app.omby.ai"),
    ).toContain("Domain=.omby.ai");
    expect(
      serializeOkouThemePreferenceCookie(
        "light",
        "pr-123-app-okou-app-preview.vm0.workers.dev",
      ),
    ).toBe(
      `${OKOU_THEME_COOKIE_NAME}=v1.light; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(serializeOkouThemePreferenceCookie("dark", "app.vm0.ai")).toBeNull();
    expect(
      readOkouThemePreferenceCookie(
        `${OKOU_THEME_COOKIE_NAME}=v0.dark; ${OKOU_THEME_COOKIE_NAME}=v1.system`,
      ),
    ).toBe("system");
  });
});
