import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$, searchParams$ } from "../../../signals/route.ts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

describe("provider setup page", () => {
  it("renders the provider setup form when no providers exist", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({
      context,
      path: "/provider-setup",
    });

    expect(screen.getByText("Define your model provider")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your model provider is required for sandboxed execution",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
  });

  it("shows form when provider exists but no return URL", async () => {
    // Default mock has a provider configured, but no return URL
    await setupPage({
      context,
      path: "/provider-setup",
    });

    expect(context.store.get(pathname$)).toBe("/provider-setup");
    expect(screen.getByText("Define your model provider")).toBeInTheDocument();
  });

  it("redirects to return URL when provider already exists", async () => {
    // Default mock has a provider configured.
    // The navigate$ during setup aborts the current route signal, causing
    // setupPage to throw AbortError. This is expected.
    await setupPage({
      context,
      path: "/provider-setup?return=/settings%3Ftab%3Dintegrations",
    }).catch(() => {});

    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/settings");
    });
    const params = context.store.get(searchParams$);
    expect(params.get("tab")).toBe("integrations");
  });

  it("continue button is disabled when no secret is entered", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({
      context,
      path: "/provider-setup",
    });

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();
  });

  it("navigates to settings when Later is clicked without return URL", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({
      context,
      path: "/provider-setup",
    });

    await user.click(screen.getByRole("button", { name: "Later" }));

    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/settings");
    });
    const params = context.store.get(searchParams$);
    expect(params.get("tab")).toBe("integrations");
  });

  it("saves provider and navigates to settings on Continue", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
      http.put("/api/model-providers", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            provider: {
              id: "new-provider",
              type: capturedBody.type,
              framework: "claude-code",
              secretName: "CLAUDE_CODE_OAUTH_TOKEN",
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
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
      path: "/provider-setup",
    });

    // Enter OAuth token
    const tokenInput = screen.getByPlaceholderText("sk-ant-oat...");
    await user.click(tokenInput);
    await user.paste("sk-ant-oat-test-token");

    // Continue button should be enabled
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);

    // Verify provider was created
    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.type).toBe("claude-code-oauth-token");
    expect(capturedBody!.secret).toBe("sk-ant-oat-test-token");

    // Should navigate to settings (default destination when no return URL)
    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/settings");
    });
  });
});
