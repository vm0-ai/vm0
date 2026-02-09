import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { VariableResponse } from "@vm0/core";

const context = testContext();
const user = userEvent.setup();

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

describe("variables tab", () => {
  it("shows list of variables with values", async () => {
    server.use(
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: mockVariables() });
      }),
    );

    await setupPage({ context, path: "/settings?tab=variables" });

    await vi.waitFor(() => {
      expect(screen.getByText("API_URL")).toBeInTheDocument();
    });
    expect(screen.getByText("DEBUG_MODE")).toBeInTheDocument();
    // Values should be visible (not masked)
    expect(screen.getByText("https://api.example.com")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText("Backend API URL")).toBeInTheDocument();
  });

  it("can add a new variable via dialog", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
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

    await setupPage({ context, path: "/settings?tab=variables" });

    // Click "Add variable"
    await user.click(screen.getByText("Add variable"));

    // Dialog should open
    const dialog = await screen.findByRole("dialog");

    // Fill in the form
    const nameInput = within(dialog).getByPlaceholderText("MY_VARIABLE");
    await user.click(nameInput);
    await user.keyboard("MY_VAR");

    const valueInput = within(dialog).getByPlaceholderText(
      "Enter variable value",
    );
    await user.click(valueInput);
    await user.keyboard("some-value");

    // Submit
    const submitButton = within(dialog).getByRole("button", {
      name: /add variable/i,
    });
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.name).toBe("MY_VAR");
    expect(capturedBody!.value).toBe("some-value");

    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("shows missing variables banner from URL required param", async () => {
    server.use(
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [mockVariables()[0]] });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=variables&required=API_URL,MISSING_VAR",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("MISSING_VAR")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Required variables not configured"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("shows empty state when no variables configured", async () => {
    server.use(
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({ context, path: "/settings?tab=variables" });

    expect(screen.getByText("No variables configured yet")).toBeInTheDocument();
    expect(screen.getByText("Add variable")).toBeInTheDocument();
  });
});
