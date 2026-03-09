import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { screen } from "@testing-library/react";

const context = testContext();

describe("zero sidebar", () => {
  it("should render clerk org switcher instead of self-hosted label when clerk auth is configured", async () => {
    await setupPage({
      context,
      path: "/zero",
    });

    // When clerk auth is configured, the self-hosted fallback should not render
    expect(screen.queryByText("Personal Workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Self-hosted")).not.toBeInTheDocument();
  });
});
