import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

function mockThreads() {
  server.use(
    http.get("*/api/zero/chat-threads/:id", ({ params }) => {
      const id = params.id as string;
      return HttpResponse.json({
        id,
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function getTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
}

describe("chat draft persistence across thread navigation", () => {
  it("should preserve input text when switching between threads", async () => {
    mockThreads();
    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(getTextarea()).toBeInTheDocument();
    });

    // Type on thread-1
    await fill(getTextarea(), "draft for thread 1");
    expect(getTextarea().value).toBe("draft for thread 1");

    // Navigate to thread-2
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-2" },
    });

    // thread-2 textarea should be empty
    await waitFor(() => {
      expect(getTextarea().value).toBe("");
    });

    // Type on thread-2
    await fill(getTextarea(), "draft for thread 2");

    // Navigate back to thread-1 — draft restored from per-thread cache
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-1" },
    });

    await waitFor(() => {
      expect(getTextarea().value).toBe("draft for thread 1");
    });

    // Navigate back to thread-2 — draft restored
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-2" },
    });

    await waitFor(() => {
      expect(getTextarea().value).toBe("draft for thread 2");
    });
  });

  it("should not leak thread draft into a different thread", async () => {
    mockThreads();
    detachedSetupPage({ context, path: "/chats/thread-a" });

    await waitFor(() => {
      expect(getTextarea()).toBeInTheDocument();
    });

    await fill(getTextarea(), "only for thread-a");

    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-b" },
    });

    await waitFor(() => {
      expect(getTextarea().value).toBe("");
    });
  });

  it("should complete upload after switching away and show it on return", async () => {
    const user = userEvent.setup();
    // Deferred upload handler — resolve manually
    let resolveUpload: (() => void) | null = null;
    const uploadStarted = new Promise<void>((resolve) => {
      resolveUpload = resolve;
    });

    let uploadRequestResolve: ((value: Response) => void) | null = null;

    server.use(
      http.get("*/api/zero/chat-threads/:id", ({ params }) => {
        const id = params.id as string;
        return HttpResponse.json({
          id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
      http.post("*/api/zero/uploads", () => {
        // Signal that the upload request has arrived
        resolveUpload?.();

        // Return a promise that we resolve later
        return new Promise<Response>((resolve) => {
          uploadRequestResolve = (resp) => {
            return resolve(resp);
          };
        });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(getTextarea()).toBeInTheDocument();
    });

    // Trigger file upload via the hidden file input
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["img-data"], "photo.png", { type: "image/png" });
    await user.upload(fileInput, file);

    // Wait for upload request to arrive at MSW
    await uploadStarted;

    // Attachment chip should be visible with uploading state
    await waitFor(() => {
      expect(
        screen.getByLabelText("Cancel upload photo.png"),
      ).toBeInTheDocument();
    });

    // Navigate to thread-2 while upload is in-flight
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-2" },
    });

    // thread-2 should have no attachment chips
    await waitFor(() => {
      expect(screen.queryByLabelText(/photo\.png/)).toBeNull();
    });

    // Now resolve the upload on the server side
    uploadRequestResolve!(
      HttpResponse.json({
        id: "upload-1",
        filename: "photo.png",
        contentType: "image/png",
        size: 1024,
        url: "https://example.com/photo.png",
      }),
    );

    // Navigate back to thread-1 — draft restored from per-thread cache,
    // upload should now be complete
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-1" },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Remove photo.png")).toBeInTheDocument();
    });
  });
});
