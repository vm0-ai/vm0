import { setupPage } from "../../../__tests__/helper";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { pathname$ } from "../../../signals/route.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

const context = testContext();

describe("home page", () => {
  it("should render the home page", async () => {
    await setupPage({
      context,
      path: "/",
    });

    expect(screen.getByText("Welcome. You're in.")).toBeDefined();
    expect(context.store.get(pathname$)).toBe("/");
  });

  it("should redirect to login if user not login", async () => {
    await setupPage({
      context,
      path: "/",
      user: null,
    });

    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
  });
});
