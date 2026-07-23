import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const MOBILE_WARNING =
  "The GitHub app may not support this OAuth link. Please complete this connection in the VM0 web app on a computer.";
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function backToVm0Link(): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Back to VM0";
  });
  if (!link) {
    throw new Error("Back to VM0 link not found");
  }
  return link;
}

describe("connector redirecting page", () => {
  it("renders the provider redirect page without an authenticated user", async () => {
    detachedSetupPage({
      context,
      path: "/connectors/github/redirecting?label=GitHub",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Redirecting to GitHub…" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("You’ll continue on GitHub to authorize VM0."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Preparing a secure connection"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Connector icon unavailable"),
    ).toBeInTheDocument();
    expect(backToVm0Link()).toHaveAttribute("href", "/");
    expect(screen.queryByText(MOBILE_WARNING)).not.toBeInTheDocument();
  });

  it("warns mobile users when the provider redirect does not leave the page", async () => {
    context.mocks.browser.userAgent(IPHONE_USER_AGENT);
    detachedSetupPage({
      context,
      path: "/connectors/github/redirecting?label=GitHub",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Redirecting to GitHub…" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(MOBILE_WARNING)).not.toBeInTheDocument();

    const warning = await screen.findByText(MOBILE_WARNING);
    expect(warning).toHaveClass("text-amber-600");
  });

  it("renders a validated catalog icon for an unknown server connector ref", async () => {
    detachedSetupPage({
      context,
      path: "/connectors/server-only/redirecting?label=Server+Only&iconUrl=https%3A%2F%2Ficons.example.test%2Fserver-only.svg&iconInvertInDarkMode=true&iconScale=1.5",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Redirecting to Server Only…" }),
    ).resolves.toBeInTheDocument();
    const icon = document.querySelector<HTMLImageElement>(
      'img[src="https://icons.example.test/server-only.svg"]',
    );
    expect(icon).toHaveClass("zero-icon-mono");
    expect(icon).toHaveStyle({ transform: "scale(1.5)" });
  });

  it("rejects invalid route icon metadata", async () => {
    detachedSetupPage({
      context,
      path: "/connectors/server-only/redirecting?label=Server+Only&iconUrl=http%3A%2F%2Ficons.example.test%2Fserver-only.svg&iconInvertInDarkMode=true",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Redirecting to Server Only…" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByLabelText("Connector icon unavailable"),
    ).toBeInTheDocument();
    expect(
      document.querySelector(
        'img[src="http://icons.example.test/server-only.svg"]',
      ),
    ).toBeNull();
  });

  it("renders an actionable error when OAuth cannot start", async () => {
    detachedSetupPage({
      context,
      path: "/connectors/github/redirecting?label=GitHub&status=error",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Couldn’t open GitHub" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("Return to VM0 and try connecting again."),
    ).toBeInTheDocument();
    expect(backToVm0Link()).toHaveAttribute("href", "/");
  });
});
