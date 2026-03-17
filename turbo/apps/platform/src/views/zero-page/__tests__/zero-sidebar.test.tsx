import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { screen, fireEvent } from "@testing-library/react";

const context = testContext();

describe("zero sidebar", () => {
  it("should render clerk org switcher", async () => {
    await setupPage({
      context,
      path: "/zero",
    });

    expect(screen.getByText("OrganizationSwitcher")).toBeInTheDocument();
  });

  it("should show export data menu item when dataExport feature switch is enabled", async () => {
    await setupPage({
      context,
      path: "/zero",
      featureSwitches: { dataExport: true },
    });

    // Open the account dropdown
    const accountButton = screen.getByText("Test User");
    fireEvent.click(accountButton);

    expect(screen.getByText("Export data")).toBeInTheDocument();
  });

  it("should not show export data menu item when dataExport feature switch is disabled", async () => {
    await setupPage({
      context,
      path: "/zero",
      featureSwitches: { dataExport: false },
    });

    // Open the account dropdown
    const accountButton = screen.getByText("Test User");
    fireEvent.click(accountButton);

    expect(screen.queryByText("Export data")).not.toBeInTheDocument();
  });
});
