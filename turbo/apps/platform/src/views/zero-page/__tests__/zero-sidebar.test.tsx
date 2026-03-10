import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { screen } from "@testing-library/react";

const context = testContext();

describe("zero sidebar", () => {
  it("should render clerk org switcher", async () => {
    await setupPage({
      context,
      path: "/zero",
    });

    expect(screen.getByText("OrganizationSwitcher")).toBeInTheDocument();
  });
});
