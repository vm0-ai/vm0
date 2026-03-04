import { describe, expect, it, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen } from "@testing-library/react";

const context = testContext();

describe("telegram connect success page", () => {
  it("renders success message and bot link when bot param is present", async () => {
    await setupPage({
      context,
      path: "/telegram/connect/success?bot=my_test_bot",
    });

    expect(context.store.get(pathname$)).toBe("/telegram/connect/success");

    expect(screen.getByText("Telegram bot connected")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your Telegram bot is now connected to VM0. You can start using it right away.",
      ),
    ).toBeInTheDocument();

    // Should show Telegram deep link
    const telegramLink = screen.getByRole("link", {
      name: "Open in Telegram",
    });
    expect(telegramLink).toBeInTheDocument();
    expect(telegramLink.getAttribute("href")).toBe("https://t.me/my_test_bot");

    // Should show platform link
    const platformLink = screen.getByRole("link", {
      name: "Go to VM0 Platform",
    });
    expect(platformLink).toBeInTheDocument();
    expect(platformLink.getAttribute("href")).toBe("/");
  });

  it("renders without telegram link when no bot param", async () => {
    await setupPage({
      context,
      path: "/telegram/connect/success",
    });

    expect(screen.getByText("Telegram bot connected")).toBeInTheDocument();

    // Should NOT show "Open in Telegram" link
    expect(
      screen.queryByRole("link", { name: "Open in Telegram" }),
    ).not.toBeInTheDocument();

    // Should still show platform link
    const platformLink = screen.getByRole("link", {
      name: "Go to VM0 Platform",
    });
    expect(platformLink).toBeInTheDocument();
  });

  it("redirects to login when not authenticated", async () => {
    await setupPage({
      context,
      path: "/telegram/connect/success",
      user: null,
    });

    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
  });

  it("auto-opens Telegram deep link on load", async () => {
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
      path: "/telegram/connect/success?bot=my_test_bot",
    });

    // The setupTelegramConnectSuccessPage$ sets window.location.href
    expect(capturedHref).toBe("https://t.me/my_test_bot");

    locationSpy.mockRestore();
  });
});
