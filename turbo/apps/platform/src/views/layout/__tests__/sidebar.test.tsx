import { describe, expect, it, vi } from "vitest";
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

    const spyOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    screen.getByText("Documentation").click();
    expect(spyOpen).toHaveBeenCalledWith("https://docs.vm0.ai", "_blank");
  });
});
