import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen } from "@testing-library/react";

const context = testContext();

describe("telegram connect success page", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });
  it("renders success message and bot link when bot param is present", async () => {
    await setupPage({
      context,
      path: "/telegram/connect/success?bot=my_test_bot",
    });

    expect(context.store.get(pathname$)).toBe("/telegram/connect/success");

    expect(screen.getByText("Telegram bot installed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your Telegram bot is now installed on VM0. You can start using it right away.",
      ),
    ).toBeInTheDocument();

    // Should show Telegram button
    const telegramButton = screen.getByRole("button", {
      name: "Open in Telegram",
    });
    expect(telegramButton).toBeInTheDocument();

    // Should show platform link
    const platformLink = screen.getByRole("link", {
      name: "Go to VM0 Platform",
    });
    expect(platformLink).toBeInTheDocument();
    expect(platformLink.getAttribute("href")).toBe("/settings/telegram");
  });

  it("renders without telegram link when no bot param", async () => {
    await setupPage({
      context,
      path: "/telegram/connect/success",
    });

    expect(screen.getByText("Telegram bot installed")).toBeInTheDocument();

    // Should NOT show "Open in Telegram" button
    expect(
      screen.queryByRole("button", { name: "Open in Telegram" }),
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
    await setupPage({
      context,
      path: "/telegram/connect/success?bot=my_test_bot",
    });

    expect(openSpy).toHaveBeenCalledWith(
      "https://t.me/my_test_bot",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
