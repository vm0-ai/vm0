import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";
import { updateFormModel$ } from "../../../signals/settings-page/model-providers.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

describe("settings page", () => {
  it("should be redirect if user has no org", async () => {
    server.use(
      http.get("/api/org", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );

    await setupPage({ context, path: "/settings" });

    expect(context.store.get(pathname$)).toBe("/");
  });

  it("shows configured providers in the list", async () => {
    await setupPage({ context, path: "/settings" });
    expect(context.store.get(pathname$)).toBe("/settings");

    // The default mock has a claude-code-oauth-token provider
    expect(screen.getByText("Claude Code (OAuth token)")).toBeInTheDocument();
  });

  it("shows empty state when no providers configured", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({ context, path: "/settings" });

    // Should show empty state and Add button but no provider rows
    expect(
      screen.getByText(
        /No providers configured. Click Add model provider to add one/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add/i })).toBeInTheDocument();
    expect(
      screen.queryByText("Claude Code (OAuth token)"),
    ).not.toBeInTheDocument();
  });

  it("can add a new provider via the dialog", async () => {
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
              id: crypto.randomUUID(),
              type: capturedBody.type,
              framework: "claude-code",
              secretName: "ANTHROPIC_API_KEY",
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

    await setupPage({ context, path: "/settings" });

    // Click Add to open add provider dialog
    const addButton = screen.getByRole("button", { name: /add/i });
    await user.click(addButton);

    // In add provider dialog, click Add on Anthropic API key card
    const addProviderDialog = await screen.findByRole("dialog", {
      name: /add model provider/i,
    });
    const anthropicCard = within(addProviderDialog).getByTestId(
      "provider-card-anthropic-api-key",
    );
    await user.click(anthropicCard);

    // Provider form dialog should open with API key input
    const providerFormTitle = await screen.findByText(
      "Add your Anthropic API key",
    );
    const dialog = providerFormTitle.closest("[role='dialog']") as HTMLElement;
    expect(dialog).toBeTruthy();

    // Fill in the API key
    const input = within(dialog).getByPlaceholderText("Enter your API key");
    await user.click(input);
    await user.paste("sk-ant-api-key-12345");

    // Submit
    const addProviderButton = within(dialog).getByRole("button", {
      name: /^add$/i,
    });
    await user.click(addProviderButton);

    // Verify request was sent with correct data and provider form closed
    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.type).toBe("anthropic-api-key");
    expect(capturedBody!.secret).toBe("sk-ant-api-key-12345");

    // Provider form dialog should close; add provider dialog may remain open
    await vi.waitFor(() => {
      expect(
        screen.queryByText("Add your Anthropic API key"),
      ).not.toBeInTheDocument();
    });
  });

  it("persists selected model when adding a provider with model selection", async () => {
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
              id: crypto.randomUUID(),
              type: capturedBody.type,
              framework: "claude-code",
              secretName: "ZAI_API_KEY",
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: (capturedBody.selectedModel as string) ?? null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({ context, path: "/settings" });

    // Click Add to open add provider dialog
    const addButton = screen.getByRole("button", { name: /add/i });
    await user.click(addButton);

    // In add provider dialog, click Add on Z.AI (GLM) card
    const addProviderDialog = await screen.findByRole("dialog", {
      name: /add model provider/i,
    });
    const zaiCard = within(addProviderDialog).getByTestId(
      "provider-card-zai-api-key",
    );
    await user.click(zaiCard);

    // Provider form dialog should open with model selector
    const providerFormTitle = await screen.findByText(
      /^Add your Z\.AI \(GLM\)$/,
    );
    const dialog = providerFormTitle.closest("[role='dialog']") as HTMLElement;
    expect(dialog).toBeTruthy();

    // Select glm-5 model via store (Radix Select doesn't render options in jsdom)
    context.store.set(updateFormModel$, "glm-5");

    // Fill in API key
    const input = within(dialog).getByPlaceholderText("Enter your API key");
    await user.click(input);
    await user.paste("test-zai-api-key");

    // Submit
    const addProviderButton = within(dialog).getByRole("button", {
      name: /^add$/i,
    });
    await user.click(addProviderButton);

    // Verify selectedModel was included in the request
    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.type).toBe("zai-api-key");
    expect(capturedBody!.secret).toBe("test-zai-api-key");
    expect(capturedBody!.selectedModel).toBe("glm-5");
  });

  it("can delete a provider via kebab menu", async () => {
    let deletedType: string | null = null;

    server.use(
      http.delete("/api/model-providers/:type", ({ params }) => {
        deletedType = params.type as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await setupPage({ context, path: "/settings" });

    // Open kebab menu for the existing provider
    const optionsButton = screen.getByRole("button", {
      name: /provider options/i,
    });
    await user.click(optionsButton);

    // Click Delete
    const deleteButton = await screen.findByText("Delete");
    await user.click(deleteButton);

    // Confirm deletion in dialog
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/are you sure/i)).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole("button", {
      name: /delete/i,
    });
    await user.click(confirmButton);

    // Verify delete API was called with correct provider type and dialog closed
    await vi.waitFor(() => {
      expect(deletedType).toBe("claude-code-oauth-token");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
