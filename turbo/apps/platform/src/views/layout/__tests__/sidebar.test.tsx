import { describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { screen } from "@testing-library/react";

const context = testContext();

describe("sidebar", () => {
  it("should open docs in new tab", async () => {
    await setupPage({
      context,
      path: "/",
    });

    const link = screen.getByText("Documentation").closest("a") as HTMLElement;
    expect(link).toHaveAttribute("href", "https://docs.vm0.ai");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
