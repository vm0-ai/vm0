import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { SecretResponse, VariableResponse } from "@vm0/core";

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

function mockVariables(): VariableResponse[] {
  return [
    {
      id: "v1",
      name: "API_URL",
      value: "https://api.example.com",
      description: "Backend API URL",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-15T00:00:00Z",
    },
    {
      id: "v2",
      name: "DEBUG_MODE",
      value: "true",
      description: null,
      createdAt: "2024-01-02T00:00:00Z",
      updatedAt: "2024-01-10T00:00:00Z",
    },
  ];
}

describe("secrets and variables tab", () => {
  it("shows both secrets and variables in one list", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: mockSecrets() });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: mockVariables() });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=secrets-and-variables",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });
    expect(screen.getByText("WEBHOOK_SECRET")).toBeInTheDocument();
    expect(screen.getByText("Main API key")).toBeInTheDocument();
    expect(screen.getByText("API_URL")).toBeInTheDocument();
    expect(screen.getByText("DEBUG_MODE")).toBeInTheDocument();
    expect(screen.getByText("https://api.example.com")).toBeInTheDocument();
  });

  it("configured items can be deleted", async () => {
    let deletedName: string | null = null;

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [mockSecrets()[0]] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.delete("/api/secrets/:name", ({ params }) => {
        deletedName = params.name as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=secrets-and-variables",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });

    // Open kebab menu
    await user.click(screen.getByRole("button", { name: /secret options/i }));

    // Click Delete
    const deleteButton = await screen.findByText("Delete");
    await user.click(deleteButton);

    // Confirm deletion
    const dialog = await screen.findByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", {
      name: /delete/i,
    });
    await user.click(confirmButton);

    await vi.waitFor(() => {
      expect(deletedName).toBe("API_KEY");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("add dropdown offers Add secret and Add variable", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=secrets-and-variables",
    });

    // Wait for the list to load
    await vi.waitFor(() => {
      expect(screen.getByText("New secrets and variables")).toBeInTheDocument();
    });

    // Open the add dropdown
    await user.click(screen.getByText("Add more secrets"));

    await expect(screen.findByText("Add secret")).resolves.toBeInTheDocument();
    expect(screen.getByText("Add variable")).toBeInTheDocument();
  });

  it("backward compat: ?tab=secrets still works", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: mockSecrets() });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({ context, path: "/settings?tab=secrets" });

    // Should land on the merged tab and show secrets content
    await vi.waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("tab", { name: /secrets and variables/i }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("backward compat: ?tab=variables still works", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: mockVariables() });
      }),
    );

    await setupPage({ context, path: "/settings?tab=variables" });

    await vi.waitFor(() => {
      expect(screen.getByText("API_URL")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("tab", { name: /secrets and variables/i }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("shows skeleton loading state before data resolves", async () => {
    let resolveSecrets: () => void = () => {};
    const secretsPromise = new Promise<void>((resolve) => {
      resolveSecrets = resolve;
    });

    server.use(
      http.get("/api/secrets", async () => {
        await secretsPromise;
        return HttpResponse.json({ secrets: mockSecrets() });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: mockVariables() });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=secrets-and-variables",
    });

    // While loading, footer and items should not be visible
    expect(
      screen.queryByText("New secrets and variables"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("API_KEY")).not.toBeInTheDocument();

    // Resolve the delayed response
    resolveSecrets();

    // Now data and footer should appear
    await vi.waitFor(() => {
      expect(screen.getByText("API_KEY")).toBeInTheDocument();
    });
    expect(screen.getByText("New secrets and variables")).toBeInTheDocument();
  });

  it("can add a new secret via dialog", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
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

    await setupPage({
      context,
      path: "/settings?tab=secrets-and-variables",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("New secrets and variables")).toBeInTheDocument();
    });

    // Open dropdown and click "Add secret"
    await user.click(screen.getByText("Add more secrets"));
    await user.click(await screen.findByText("Add secret"));

    // Dialog should open
    const dialog = await screen.findByRole("dialog");

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

  it("can add a new variable via dialog", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.put("/api/variables", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: crypto.randomUUID(),
            name: capturedBody.name,
            value: capturedBody.value,
            description: capturedBody.description ?? null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=secrets-and-variables",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("New secrets and variables")).toBeInTheDocument();
    });

    // Open dropdown and click "Add variable"
    await user.click(screen.getByText("Add more secrets"));
    await user.click(await screen.findByText("Add variable"));

    // Dialog should open
    const dialog = await screen.findByRole("dialog");

    // Fill in the form
    const nameInput = within(dialog).getByPlaceholderText("MY_VARIABLE");
    await user.click(nameInput);
    await user.paste("MY_VAR");

    const valueInput = within(dialog).getByPlaceholderText(
      "Enter variable value",
    );
    await user.click(valueInput);
    await user.paste("some-value");

    // Submit
    const submitButton = within(dialog).getByRole("button", {
      name: /add variable/i,
    });
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(capturedBody!.name).toBe("MY_VAR");
    expect(capturedBody!.value).toBe("some-value");
  });

  it("validates secret name on add", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=secrets-and-variables",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("New secrets and variables")).toBeInTheDocument();
    });

    // Open dropdown and click "Add secret"
    await user.click(screen.getByText("Add more secrets"));
    await user.click(await screen.findByText("Add secret"));

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
