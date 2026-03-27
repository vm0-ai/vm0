import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat message lifecycle", () => {
  it("should show user message and assistant response after sending", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "What can you do?");

    // User message appears
    await waitFor(() => {
      expect(screen.getByText("What can you do?")).toBeInTheDocument();
    });

    // Assistant thinking indicator appears
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    ctrl.completeRun("I can help with many things!");

    // Assistant response replaces thinking
    await waitFor(() => {
      expect(
        screen.getByText("I can help with many things!"),
      ).toBeInTheDocument();
    });
  });

  it("should display error when run creation fails", async () => {
    mockChatLifecycle();
    server.use(
      http.post("*/api/zero/runs", () =>
        HttpResponse.json(
          { error: { message: "Some API error", code: "BAD_REQUEST" } },
          { status: 400 },
        ),
      ),
    );

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByText(/Some API error/)).toBeInTheDocument();
    });
  });

  it("should show provider incompatibility guidance", async () => {
    mockChatLifecycle();
    server.use(
      http.post("*/api/zero/runs", () =>
        HttpResponse.json(
          {
            error: {
              message:
                "Cannot continue session: this session was created with Moonshot (Kimi) and cannot be continued with Anthropic API Key",
              code: "PROVIDER_INCOMPATIBLE",
            },
          },
          { status: 400 },
        ),
      ),
    );

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByText(/different model provider/)).toBeInTheDocument();
    });
  });

  it("should display generic error when error body is unparseable", async () => {
    mockChatLifecycle();
    server.use(
      http.post(
        "*/api/zero/runs",
        () => new HttpResponse("Bad Gateway", { status: 502 }),
      ),
    );

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByText(/502/)).toBeInTheDocument();
    });
  });

  it("should display error when thread creation fails", async () => {
    mockChatLifecycle();
    server.use(
      http.post(
        "*/api/zero/chat-threads",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByText(/chat thread/i)).toBeInTheDocument();
    });
  });

  it("should not send empty messages", async () => {
    mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "   ");

    // Empty message prompt — still visible, no new messages
    await waitFor(() => {
      expect(
        screen.getByText("Send a message to start the conversation"),
      ).toBeInTheDocument();
    });
  });
});
