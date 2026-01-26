import { setupPage } from "../../../__tests__/helper";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
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

  it("should show onboarding modal when no claude-code-oauth-token exists", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({
      context,
      path: "/",
    });

    expect(screen.getByText(/First, tell us how your LLM works/)).toBeDefined();
  });

  it("should not show onboarding modal when both scope and oauth token exist", async () => {
    // Default mocks have both scope and oauth token
    await setupPage({
      context,
      path: "/",
    });

    expect(screen.queryByText(/First, tell us how your LLM works/)).toBeNull();
  });

  it("should create model provider when Save button is clicked", async () => {
    let providerCreated = false;
    let createdType: string | null = null;

    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.post("/api/scope", () => {
        return HttpResponse.json({}, { status: 201 });
      }),
      http.put("/api/model-providers", async ({ request }) => {
        providerCreated = true;
        const body = (await request.json()) as {
          type: string;
          credential: string;
        };
        createdType = body.type;
        return HttpResponse.json(
          {
            provider: {
              id: "new-provider",
              type: body.type,
              framework: "claude-code",
              credentialName: "CLAUDE_CODE_OAUTH_TOKEN",
              isDefault: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({
      context,
      path: "/",
    });

    // Type a token value
    const tokenInput = screen.getByPlaceholderText("sk-ant-oat...");
    await user.type(tokenInput, "sk-ant-oat-test-token");

    // Click Save
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Wait for async operations
    await vi.waitFor(() => {
      expect(providerCreated).toBeTruthy();
    });
    expect(createdType).toBe("claude-code-oauth-token");
    expect(screen.queryByText(/First, tell us how your LLM works/)).toBeNull();
  });
});
