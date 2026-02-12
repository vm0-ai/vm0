import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { SecretResponse } from "@vm0/core";

const context = testContext();
const user = userEvent.setup();

function mockSecrets(): SecretResponse[] {
  return [
    {
      id: "s1",
      name: "API_KEY",
      description: "Main API key",
      type: "user",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-15T00:00:00Z",
    },
    {
      id: "s2",
      name: "WEBHOOK_SECRET",
      description: null,
      type: "user",
      createdAt: "2024-01-02T00:00:00Z",
      updatedAt: "2024-01-10T00:00:00Z",
    },
  ];
}

describe("secrets tab", () => {
  it("shows secrets tab and switches to it", async () => {
    await setupPage({ context, path: "/settings" });

    // Should start on providers tab
    expect(screen.getByText("Claude Code (OAuth token)")).toBeInTheDocument();

    // Click Secrets tab
    await user.click(screen.getByRole("tab", { name: /secrets/i }));

    // Should show secrets content (description is unique to the secrets section)
    expect(
      screen.getByText(/encrypted credentials used by your agents/i),
    ).toBeInTheDocument();
  });

  it("does not flash empty state while loading", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: mockSecrets() });
      }),
    );

    await setupPage({ context, path: "/settings?tab=secrets" });

    // Should not show empty state while data is loading
    expect(
      screen.queryByText("No secrets configured yet"),
    ).not.toBeInTheDocument();

    // Wait for data to load
    await vi.waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });
  });

  it("shows empty state when no secrets configured", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
    );

    await setupPage({ context, path: "/settings?tab=secrets" });

    await vi.waitFor(() => {
      expect(screen.getByText("No secrets configured yet")).toBeInTheDocument();
    });
    expect(screen.getByText("Add secret")).toBeInTheDocument();
  });

  it("shows list of existing secrets", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: mockSecrets() });
      }),
    );

    await setupPage({ context, path: "/settings?tab=secrets" });

    await vi.waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });
    expect(screen.getByText("WEBHOOK_SECRET")).toBeInTheDocument();
    expect(screen.getByText("Main API key")).toBeInTheDocument();
  });

  it("can add a new secret via dialog", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.put("/api/secrets", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: crypto.randomUUID(),
            name: capturedBody.name,
            description: capturedBody.description ?? null,
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({ context, path: "/settings?tab=secrets" });

    // Wait for data to resolve before "Add secret" button appears
    await vi.waitFor(() => {
      expect(screen.getByText("Add secret")).toBeInTheDocument();
    });

    // Click "Add secret"
    await user.click(screen.getByText("Add secret"));

    // Dialog should open
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Add an encrypted secret for your agents to use",
      ),
    ).toBeInTheDocument();

    // Fill in the form
    const nameInput = within(dialog).getByPlaceholderText("MY_API_KEY");
    await user.click(nameInput);
    await user.paste("NEW_SECRET");

    const valueInput =
      within(dialog).getByPlaceholderText("Enter secret value");
    await user.click(valueInput);
    await user.paste("super-secret-value");

    // Submit
    const submitButton = within(dialog).getByRole("button", {
      name: /add secret/i,
    });
    await user.click(submitButton);

    // Verify request and dialog closed
    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(capturedBody!.name).toBe("NEW_SECRET");
    expect(capturedBody!.value).toBe("super-secret-value");
  });

  it("can delete a secret via kebab menu", async () => {
    let deletedName: string | null = null;

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [mockSecrets()[0]] });
      }),
      http.delete("/api/secrets/:name", ({ params }) => {
        deletedName = params.name as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await setupPage({ context, path: "/settings?tab=secrets" });

    await vi.waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });

    // Open kebab menu
    const optionsButton = screen.getByRole("button", {
      name: /secret options/i,
    });
    await user.click(optionsButton);

    // Click Delete
    const deleteButton = await screen.findByText("Delete");
    await user.click(deleteButton);

    // Confirm deletion
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/are you sure/i)).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole("button", {
      name: /delete/i,
    });
    await user.click(confirmButton);

    await vi.waitFor(() => {
      expect(deletedName).toBe("API_KEY");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("shows missing secrets banner from URL required param", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [mockSecrets()[0]] });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=secrets&required=API_KEY,MISSING_KEY",
    });

    // API_KEY exists so should not be in missing banner
    // MISSING_KEY doesn't exist so should appear as missing
    await vi.waitFor(() => {
      expect(screen.getByText("MISSING_KEY")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Required secrets not configured"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("validates name format on add", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
    );

    await setupPage({ context, path: "/settings?tab=secrets" });

    // Wait for data to resolve before "Add secret" button appears
    await vi.waitFor(() => {
      expect(screen.getByText("Add secret")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Add secret"));

    const dialog = await screen.findByRole("dialog");

    // Try to submit empty
    const submitButton = within(dialog).getByRole("button", {
      name: /add secret/i,
    });
    await user.click(submitButton);

    expect(
      within(dialog).getByText("Secret name is required"),
    ).toBeInTheDocument();
  });
});
