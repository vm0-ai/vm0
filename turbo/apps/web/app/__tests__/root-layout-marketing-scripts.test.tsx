import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RootLayout from "../layout";
import { reloadEnv } from "../../src/env";

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
      return (
        <template data-script-id={id} data-script-src={src}>
          {children}
        </template>
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
    ClerkProvider: ({ children }: { children: ReactNode }) => {
      return <>{children}</>;
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

async function renderRootLayoutHtml(): Promise<string> {
  return renderToStaticMarkup(
    await RootLayout({
      children: <main>content</main>,
    }),
  );
}

describe("root layout marketing scripts", () => {
  it("does not load ad pixels in preview deployments", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    reloadEnv();

    const html = await renderRootLayoutHtml();

    expect(html).not.toContain("www.googletagmanager.com/gtag/js");
    expect(html).not.toContain("AW-18144854014");
    expect(html).not.toContain(
      "snap.licdn.com/li.lms-analytics/insight.min.js",
    );
    expect(html).not.toContain("px.ads.linkedin.com/collect");
    expect(html).not.toContain("app.termly.io/resource-blocker");
  });

  it("loads ad pixels in production deployments", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    reloadEnv();

    const html = await renderRootLayoutHtml();

    expect(html).toContain("www.googletagmanager.com/gtag/js");
    expect(html).toContain("AW-18144854014");
    expect(html).toContain("snap.licdn.com/li.lms-analytics/insight.min.js");
    expect(html).toContain("px.ads.linkedin.com/collect");
    expect(html).toContain("app.termly.io/resource-blocker");
  });
});
