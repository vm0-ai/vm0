import { describe, expect, it, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen } from "@testing-library/react";

const context = testContext();

describe("slack connect success page", () => {
  it("renders success message and navigation links", async () => {
    await setupPage({
      context,
      path: "/slack/connect/success?w=T123&c=C789",
    });

    expect(context.store.get(pathname$)).toBe("/slack/connect/success");

    expect(
      screen.getByText("VM0 account connected with Slack"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Close this window and return to Slack"),
    ).toBeInTheDocument();

    // Should show navigation links
    const slackLink = screen.getByRole("link", { name: "Go to Slack" });
    expect(slackLink).toBeInTheDocument();
    expect(slackLink.getAttribute("href")).toBe(
      "slack://channel?team=T123&id=C789",
    );

    const platformLink = screen.getByRole("link", {
      name: "Go to VM0 Platform",
    });
    expect(platformLink).toBeInTheDocument();
    expect(platformLink.getAttribute("href")).toBe("/");
  });

  it("renders generic slack link when no workspace/channel params", async () => {
    await setupPage({
      context,
      path: "/slack/connect/success",
    });

    expect(
      screen.getByText("VM0 account connected with Slack"),
    ).toBeInTheDocument();

    const slackLink = screen.getByRole("link", { name: "Go to Slack" });
    expect(slackLink.getAttribute("href")).toBe("slack://open");
  });

  it("redirects to login when not authenticated", async () => {
    const { mockedClerk } = await import("../../../__tests__/mock-auth.ts");

    await setupPage({
      context,
      path: "/slack/connect/success",
      user: null,
    });

    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
  });

  it("auto-opens Slack deep link on load", async () => {
    // The success page sets window.location.href to the Slack deep link.
    // In happy-dom test environment, we can verify the href was set.
    const locationSpy = vi.spyOn(window, "location", "get");
    const mockLocation = {
      ...window.location,
      href: "",
    };
    let capturedHref = "";
    Object.defineProperty(mockLocation, "href", {
      get: () => capturedHref,
      set: (val: string) => {
        capturedHref = val;
      },
    });
    locationSpy.mockReturnValue(mockLocation as Location);

    await setupPage({
      context,
      path: "/slack/connect/success?w=T123&c=C789",
    });

    // The setupSlackConnectSuccessPage$ sets window.location.href
    expect(capturedHref).toBe("slack://channel?team=T123&id=C789");

    locationSpy.mockRestore();
  });
});
