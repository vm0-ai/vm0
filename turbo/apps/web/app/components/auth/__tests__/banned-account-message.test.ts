import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RootLayout from "../../../layout";
import { reloadEnv } from "../../../../src/env";
import { VM0_CLERK_LOCALIZATION } from "../banned-account-message";

const clerkProviderProps = vi.hoisted(() => {
  return {
    current: undefined as
      | undefined
      | {
          localization?: unknown;
        },
  };
});

vi.mock("next/script", () => {
  return {
    default: ({
      children,
      id,
      src,
    }: {
      children?: ReactNode;
      id?: string;
      src?: string;
    }) => {
      return createElement(
        "template",
        {
          "data-script-id": id,
          "data-script-src": src,
        },
        children,
      );
    },
  };
});

vi.mock("next/font/google", () => {
  const font = () => {
    return { variable: "font-variable" };
  };

  return {
    Fira_Code: font,
    Fira_Mono: font,
    JetBrains_Mono: font,
    Noto_Sans: font,
  };
});

vi.mock("next/dynamic", () => {
  return {
    default: () => {
      return function DynamicComponent() {
        return null;
      };
    },
  };
});

vi.mock("@clerk/nextjs", () => {
  return {
    ClerkProvider: ({
      children,
      localization,
    }: {
      children: ReactNode;
      localization?: unknown;
    }) => {
      clerkProviderProps.current = { localization };
      return createElement("div", null, children);
    },
    GoogleOneTap: () => {
      return null;
    },
  };
});

vi.mock("next-intl/server", () => {
  return {
    getLocale: () => {
      return Promise.resolve("en");
    },
  };
});

async function renderRootLayout(): Promise<void> {
  renderToStaticMarkup(
    await RootLayout({
      children: createElement("main", null, "content"),
    }),
  );
}

describe("VM0_CLERK_LOCALIZATION", () => {
  beforeEach(() => {
    clerkProviderProps.current = undefined;
    vi.stubEnv("VERCEL_ENV", "preview");
    reloadEnv();
  });

  it("configures Clerk with separate text for banned accounts and regular access errors", async () => {
    await renderRootLayout();

    expect(clerkProviderProps.current?.localization).toBe(
      VM0_CLERK_LOCALIZATION,
    );
    expect(VM0_CLERK_LOCALIZATION.unstable__errors.user_banned).toContain(
      "support@vm0.ai",
    );
    expect(VM0_CLERK_LOCALIZATION.unstable__errors.user_banned).toContain(
      "violated the vm0 Terms of Use",
    );
    expect(VM0_CLERK_LOCALIZATION.unstable__errors.not_allowed_access).toBe(
      "Access is not allowed.",
    );
    expect(VM0_CLERK_LOCALIZATION.unstable__errors.user_banned).not.toBe(
      VM0_CLERK_LOCALIZATION.unstable__errors.not_allowed_access,
    );
  });
});
