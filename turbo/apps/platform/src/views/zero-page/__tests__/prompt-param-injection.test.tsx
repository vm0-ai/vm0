import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
    await setupPage({ context, path: "/?prompt=Hello%20world" });

    // Should redirect to /talk/:id and show the prompt in the input
    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
    );

    expect(textarea).toHaveValue("Hello world");
  });

  it("should inject ?prompt= into chat input when navigating to /talk/:id", async () => {
    mockChatAPI();
    await setupPage({
      context,
      path: "/talk/mock-compose-id?prompt=Set%20up%20a%20daily%20report",
    });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
    );

    expect(textarea).toHaveValue("Set up a daily report");
  });

  it("should strip ?prompt= from URL after injection", async () => {
    mockChatAPI();
    await setupPage({
      context,
      path: "/talk/mock-compose-id?prompt=test",
    });

    await waitFor(
      () => {
        expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // The prompt param should be removed from the URL
    expect(search()).not.toContain("prompt=");
  });

  it("should not modify input when no ?prompt= is present", async () => {
    mockChatAPI();
    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
    );

    expect(textarea).toHaveValue("");
  });

  it("should redirect from / to /talk/:id with prompt in URL", async () => {
    mockChatAPI();
    await setupPage({ context, path: "/?prompt=hello" });

    await waitFor(
      () => {
        expect(pathname()).toMatch(/^\/talk\//);
      },
      { timeout: 5000 },
    );
  });
});
