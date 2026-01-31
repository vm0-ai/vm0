import { describe, expect, it } from "vitest";
import { server } from "../../../mocks/server";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { pathname$ } from "../../../signals/route";
import { screen } from "@testing-library/react";
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

  it("can edit and save user claude oauth token", async () => {
    const { store } = context;

    await setupPage({ context, path: "/settings" });
    expect(store.get(pathname$)).toBe("/settings");

    const input = screen.queryByPlaceholderText(/sk-ant.*/i);
    expect(input).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();

    await user.click(input!);
    await user.keyboard("sk-ant-oauth-token-12345");

    const button = screen.getByRole("button", { name: /save/i });
    await user.click(button);

    expect(button).not.toBeInTheDocument();
    // After saving, the input should show the masked token
    expect(input).toHaveValue("sk-ant-oat-••••••••••••••••");
  });

  it("can cancel input", async () => {
    const { store } = context;

    await setupPage({ context, path: "/settings" });
    expect(store.get(pathname$)).toBe("/settings");

    const input = screen.getByPlaceholderText(/sk-ant.*/i);
    await user.click(input);
    await user.keyboard("sk-ant-oauth-token-12345");

    expect(input).toHaveValue("sk-ant-oauth-token-12345");

    const button = screen.getByRole("button", { name: /cancel/i });
    await user.click(button);

    expect(button).not.toBeInTheDocument();

    // After canceling, the input should show the masked token (not empty)
    expect(input).toHaveValue("sk-ant-oat-••••••••••••••••");
  });

  it('should be empty if use does not have "claude-code-oauth-token" provider', async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({ context, path: "/settings" });

    // When no token exists, placeholder should be "sk-ant-oat..."
    const input = screen.getByPlaceholderText("sk-ant-oat...");
    expect(input).toBeInTheDocument();
  });

  it('can delete existing "claude-code-oauth-token" provider', async () => {
    const { store } = context;

    await setupPage({ context, path: "/settings" });
    expect(store.get(pathname$)).toBe("/settings");

    const input = screen.getByPlaceholderText(/sk-ant.*/i);

    // Changed from "delete claude code oauth token" to "Clear token"
    const deleteButton = screen.getByRole("button", {
      name: /clear token/i,
    });
    await user.click(deleteButton);

    // After deletion, placeholder should still be "sk-ant-oat..."
    expect(input).toHaveProperty("placeholder", "sk-ant-oat...");

    await user.click(input);
    await user.keyboard("sk-ant-oauth-token-12345");

    expect(input).toHaveValue("sk-ant-oauth-token-12345");
    const button = screen.getByRole("button", { name: /save/i });
    await user.click(button);

    // After saving, should show masked token
    expect(input).toHaveValue("sk-ant-oat-••••••••••••••••");
  });
});
