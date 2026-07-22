import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("connector redirecting page", () => {
  it("renders the provider handoff without an authenticated user", async () => {
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
      screen.getByText("You’ll continue on GitHub to authorize Zero."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Preparing a secure connection"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Connector icon unavailable"),
    ).toBeInTheDocument();
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
      screen.getByText("Return to Zero and try connecting again."),
    ).toBeInTheDocument();
    expect(screen.getByText("Close window")).toBeInTheDocument();
  });
});
