import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();

const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

function mockChatAPI() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("prompt query parameter injection", () => {
  it("should inject ?prompt= into chat input when navigating to /", async () => {
    mockChatAPI();
    detachedSetupPage({ context, path: "/?prompt=Hello%20world" });

    // Should redirect to /talk/:id and show the prompt in the input
    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(textarea).toHaveValue("Hello world");
  });

  it("should inject ?prompt= into chat input when navigating to /talk/:id", async () => {
    mockChatAPI();
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat?prompt=Set%20up%20a%20daily%20report",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(textarea).toHaveValue("Set up a daily report");
  });

  it("should strip ?prompt= from URL after injection", async () => {
    mockChatAPI();
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat?prompt=test",
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    // The prompt param should be removed from the URL
    expect(search()).not.toContain("prompt=");
  });

  it("should not modify input when no ?prompt= is present", async () => {
    mockChatAPI();
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(textarea).toHaveValue("");
  });

  it("should redirect from / to /talk/:id with prompt in URL", async () => {
    mockChatAPI();
    detachedSetupPage({ context, path: "/?prompt=hello" });

    await waitFor(() => {
      expect(pathname()).toMatch(/^\/agents\//);
    });
  });
});
