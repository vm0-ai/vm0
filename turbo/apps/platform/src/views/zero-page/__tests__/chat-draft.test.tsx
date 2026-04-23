import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { toast } from "@vm0/ui/components/ui/sonner";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { createMockApi, createMockHttp } from "../../../mocks/msw-contract.ts";
import { chatThreadByIdContract } from "@vm0/core";

vi.mock("@vm0/ui/components/ui/sonner", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@vm0/ui/components/ui/sonner");
  return {
    ...actual,
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
});

const context = testContext();
const mockApi = createMockApi(context);
const mockHttp = createMockHttp(context);

function mockThreads() {
  server.use(
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
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
    const uploadStarted = createDeferredPromise<void>(context.signal);
    let uploadRequestDeferred: ReturnType<
      typeof createDeferredPromise<Response>
    > | null = null;

    server.use(
      mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
        return respond(200, {
          id: params.id,
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
      // mockApi cannot be used here: /api/zero/uploads/prepare is an internal
      // helper endpoint whose response shape is owned by the route; we want to
      // defer the PUT to R2 so tests that need a deferred upload can resolve
      // it manually.
      mockHttp.post("*/api/zero/uploads/prepare", () => {
        return HttpResponse.json({
          id: "upload-1",
          filename: "photo.png",
          contentType: "image/png",
          size: 1024,
          uploadUrl: "https://mock-upload.example.com/photo.png",
          url: "https://example.com/photo.png",
        });
      }),
      mockHttp.put(
        "https://mock-upload.example.com/photo.png",
        ({ signal }) => {
          uploadStarted.resolve();
          uploadRequestDeferred = createDeferredPromise<Response>(signal);
          return uploadRequestDeferred.promise;
        },
      ),
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
    await uploadStarted.promise;

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

    // Now resolve the deferred PUT to R2
    uploadRequestDeferred!.resolve(new HttpResponse(null, { status: 200 }));

    // Navigate back to thread-1 — draft restored from per-thread cache,
    // upload should now be complete
    context.store.set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: "thread-1" },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Remove photo.png")).toBeInTheDocument();
    });
  });

  it("should toast and drop the chip when prepare returns an error", async () => {
    const user = userEvent.setup();
    mockThreads();
    server.use(
      // mockApi cannot be used here: we want to assert UI behavior when the
      // server returns an error shape directly without going through the
      // typed happy path.
      mockHttp.post("*/api/zero/uploads/prepare", () => {
        return HttpResponse.json(
          {
            error: {
              message: "File too large (max 1 GB)",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-err-1" });

    await waitFor(() => {
      expect(getTextarea()).toBeInTheDocument();
    });

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["bad"], "huge.png", { type: "image/png" });
    await user.upload(fileInput, file);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("File too large"),
      );
    });
    expect(screen.queryByLabelText(/huge\.png/)).toBeNull();
  });

  it("should toast and drop the chip when the R2 put fails", async () => {
    const user = userEvent.setup();
    mockThreads();
    server.use(
      // mockApi cannot be used here: /api/zero/uploads/prepare is an internal
      // helper endpoint with no ts-rest contract.
      mockHttp.post("*/api/zero/uploads/prepare", () => {
        return HttpResponse.json({
          id: "upload-err",
          filename: "fail.png",
          contentType: "image/png",
          size: 1024,
          uploadUrl: "https://mock-upload.example.com/fail.png",
          url: "https://example.com/fail.png",
        });
      }),
      mockHttp.put("https://mock-upload.example.com/fail.png", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    detachedSetupPage({ context, path: "/chats/thread-err-2" });

    await waitFor(() => {
      expect(getTextarea()).toBeInTheDocument();
    });

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["x"], "fail.png", { type: "image/png" });
    await user.upload(fileInput, file);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("storage returned 500"),
      );
    });
    expect(screen.queryByLabelText(/fail\.png/)).toBeNull();
  });
});
