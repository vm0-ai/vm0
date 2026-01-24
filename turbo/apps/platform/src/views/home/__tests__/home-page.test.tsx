import { setupPage } from "../../../__tests__/helper";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { pathname$ } from "../../../signals/route.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

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

  it("should show onboarding modal when scope returns 404", async () => {
    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.post("/api/scope", () => {
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await setupPage({
      context,
      path: "/",
    });

    expect(screen.getByText(/First, tell us how your LLM works/)).toBeDefined();

    // Save button should be disabled when token is empty
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();

    // Type a token value
    const tokenInput = screen.getByPlaceholderText("sk-ant-oat...");
    await user.type(tokenInput, "sk-ant-oat-test-token");

    // Save button should now be enabled
    expect(saveButton).toBeEnabled();

    // Click "Add it later" to close the modal
    await user.click(screen.getByText("Add it later"));

    expect(screen.queryByText(/First, tell us how your LLM works/)).toBeNull();
  });
});
