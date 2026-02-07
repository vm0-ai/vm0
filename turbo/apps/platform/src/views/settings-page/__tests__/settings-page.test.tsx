import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

describe("settings page", () => {
  it("should be redirect if user has no scope", async () => {
    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.post("/api/scope", () => {
        return new HttpResponse(null, { status: 201 });
      }),
    );

    await setupPage({ context, path: "/settings" });

    expect(context.store.get(pathname$)).toBe("/");
  });

  it("shows configured providers in the list", async () => {
    await setupPage({ context, path: "/settings" });
    expect(context.store.get(pathname$)).toBe("/settings");

    // The default mock has a claude-code-oauth-token provider
    expect(screen.getByText("Claude Code OAuth token")).toBeInTheDocument();
  });

  it("shows empty state when no providers configured", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({ context, path: "/settings" });

    // Should show "New model provider" button but no provider rows
    expect(screen.getByText("New model provider")).toBeInTheDocument();
    expect(
      screen.queryByText("Claude Code OAuth token"),
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

    // Click "Add more model provider" to open dropdown
    const addButton = screen.getByText("Add more model provider");
    await user.click(addButton);

    // Select "Anthropic API key" from the menu
    const anthropicOption = await screen.findByText("Anthropic API key");
    await user.click(anthropicOption);

    // Dialog should open with API key input
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Add your Anthropic API key"),
    ).toBeInTheDocument();

    // Fill in the API key
    const input = within(dialog).getByPlaceholderText("Enter your API key");
    await user.click(input);
    await user.keyboard("sk-ant-api-key-12345");

    // Submit
    const addProviderButton = within(dialog).getByRole("button", {
      name: /^add$/i,
    });
    await user.click(addProviderButton);

    // Verify request was sent with correct data and dialog closed
    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.type).toBe("anthropic-api-key");
    expect(capturedBody!.secret).toBe("sk-ant-api-key-12345");

    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
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
    });

    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
