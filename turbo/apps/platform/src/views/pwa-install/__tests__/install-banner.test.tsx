import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockIOSSafariUA(isIOS: boolean): void {
  const ua = isIOS
    ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  context.mocks.browser.userAgent(ua);
}

describe("install banner", () => {
  it("lets an iOS Safari user open or dismiss the install prompt", async () => {
    context.mocks.browser.standaloneDisplayMode(false);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    const installButton = await waitFor(() => {
      expect(
        screen.getByLabelText("Dismiss install banner"),
      ).toBeInTheDocument();
      return screen.getByLabelText("Install app");
    });

    click(installButton);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Install Zero" }),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Dismiss install banner"));

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Dismiss install banner"),
      ).not.toBeInTheDocument();
    });
  });

  it("hides the banner for a standalone app", async () => {
    context.mocks.browser.standaloneDisplayMode(true);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Dismiss install banner"),
    ).not.toBeInTheDocument();
  });
});
