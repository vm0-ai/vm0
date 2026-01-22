import { describe, it, expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/helper.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen } from "@testing-library/react";

const context = testContext();

describe("logs page", () => {
  it("should render the logs page", async () => {
    await setupPage({
      context,
      path: "/logs",
    });

    expect(
      screen.getByText("View all agent runs and execution history."),
    ).toBeDefined();
    expect(context.store.get(pathname$)).toBe("/logs");
  });
});
