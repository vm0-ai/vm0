import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
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

    expect(screen.getByText("Telegram Bot Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open in Telegram" }),
    ).toHaveAttribute("href", "tg://resolve?domain=my_test_bot");
  });

  it("renders success message without bot link when bot param is missing", async () => {
    await setupPage({
      context,
      path: "/telegram/connect/success",
    });

    expect(screen.getByText("Telegram Bot Connected")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open in Telegram" }),
    ).not.toBeInTheDocument();
  });

  it("renders Go to VM0 Platform link", async () => {
    await setupPage({
      context,
      path: "/telegram/connect/success?bot=my_test_bot",
    });

    expect(
      screen.getByRole("link", { name: "Go to VM0 Platform" }),
    ).toBeInTheDocument();
  });

  it("auto-opens Telegram via protocol handler on load", async () => {
    await setupPage({
      context,
      path: "/telegram/connect/success?bot=my_test_bot",
    });

    expect(openSpy).toHaveBeenCalledWith(
      "tg://resolve?domain=my_test_bot",
      "_blank",
    );
  });
});
