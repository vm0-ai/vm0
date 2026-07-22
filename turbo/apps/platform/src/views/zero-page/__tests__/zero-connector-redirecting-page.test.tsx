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
