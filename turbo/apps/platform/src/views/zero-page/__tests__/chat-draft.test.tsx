import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

function mockThreadDetails(): void {
  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(200, {
      pinned: [],
      threads: [
        {
          id: "thread-1",
          title: "Thread 1",
          agent: {
            id: "c0000000-0000-4000-a000-000000000001",
            avatarUrl: null,
          },
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          running: false,
        },
        {
          id: "thread-2",
          title: "Thread 2",
          agent: {
            id: "c0000000-0000-4000-a000-000000000001",
            avatarUrl: null,
          },
          createdAt: "2026-03-10T00:01:00Z",
          updatedAt: "2026-03-10T00:01:00Z",
          running: false,
        },
        {
          id: "thread-uploads",
          title: "Uploads",
          agent: {
            id: "c0000000-0000-4000-a000-000000000001",
            avatarUrl: null,
          },
          createdAt: "2026-03-10T00:02:00Z",
          updatedAt: "2026-03-10T00:02:00Z",
          running: false,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      title: null,
      agentId: "c0000000-0000-4000-a000-000000000001",
      activeRunIds: [],
      draftContent: null,
      draftAttachments: null,
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    });
  });
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
}

function chatClipboardHtml(payload: {
  text: string;
  attachments: {
    id: string | null;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }[];
}): string {
  return `<div data-vm0-chat-message="${encodeURIComponent(
    JSON.stringify(payload),
  )}"></div>`;
}

async function navigateToThread(threadId: string): Promise<void> {
  const link = await waitFor(() => {
    return queryAllByRoleFast("link").find((element) => {
      return element.getAttribute("href") === `/chats/${threadId}`;
    });
  });
  if (!link) {
    throw new Error(`Thread link not found: ${threadId}`);
  }
  click(link);
}

describe("chat drafts", () => {
  it("preserves per-thread text drafts while navigating", async () => {
    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockThreadDetails();

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(textarea()).toBeInTheDocument();
    });
    await fill(textarea(), "draft for thread 1");

    await navigateToThread("thread-2");
    await waitFor(() => {
      expect(textarea()).toHaveValue("");
    });
    await fill(textarea(), "draft for thread 2");

    await navigateToThread("thread-1");
    await waitFor(() => {
      expect(textarea()).toHaveValue("draft for thread 1");
    });

    await navigateToThread("thread-2");
    await waitFor(() => {
      expect(textarea()).toHaveValue("draft for thread 2");
    });
  });

  it("restores a saved server draft with attachments on first thread open", async () => {
    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockThreadDetails();
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: "Saved draft",
        agentId: "c0000000-0000-4000-a000-000000000001",
        activeRunIds: [],
        draftContent: "Review the saved launch brief",
        draftAttachments: [
          {
            id: "draft-brief",
            filename: "brief.md",
            contentType: "text/markdown",
            size: 64,
            url: "https://cdn.vm7.io/artifacts/test/drafts/brief.md",
          },
        ],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });

    detachedSetupPage({ context, path: "/chats/thread-server-draft" });

    await waitFor(() => {
      expect(textarea()).toHaveValue("Review the saved launch brief");
      expect(screen.getByLabelText("Remove brief.md")).toBeInTheDocument();
    });
  });

  it("persists edited draft attachments and clears the server draft after sending", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-draft-sync";
    const draftPatches: Record<string, unknown>[] = [];
    mockChatLifecycle(context, { threadId });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: threadId,
        title: "Draft sync",
        agentId: "c0000000-0000-4000-a000-000000000001",
        activeRunIds: [],
        draftContent: "Review the saved launch brief",
        draftAttachments: [
          {
            id: "draft-brief",
            filename: "brief.md",
            contentType: "text/markdown",
            size: 64,
            url: "https://cdn.vm7.io/artifacts/test/drafts/brief.md",
          },
        ],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
      draftPatches.push(body as Record<string, unknown>);
      return respond(204);
    });
    context.mocks.upload.success({
      id: "fresh-launch-note",
      filename: "fresh.txt",
      contentType: "text/plain",
      size: 5,
      url: "https://cdn.vm7.io/artifacts/test/drafts/fresh.txt",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(textarea()).toHaveValue("Review the saved launch brief");
      expect(screen.getByLabelText("Remove brief.md")).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["fresh"], "fresh.txt", { type: "text/plain" }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Remove fresh.txt")).toBeInTheDocument();
    });

    await fill(textarea(), "Review the updated launch brief");

    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftContent: "Review the updated launch brief",
        draftAttachments: [
          {
            id: "draft-brief",
            url: "https://cdn.vm7.io/artifacts/test/drafts/brief.md",
            filename: "brief.md",
            contentType: "text/markdown",
            size: 64,
          },
          {
            id: "fresh-launch-note",
            url: "https://cdn.vm7.io/artifacts/test/drafts/fresh.txt",
            filename: "fresh.txt",
            contentType: "text/plain",
            size: 5,
          },
        ],
      });
    });

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        screen.getByText("Review the updated launch brief"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Type your next message/)).toHaveValue(
        "",
      );
      expect(draftPatches).toContainEqual({
        draftContent: null,
        draftAttachments: null,
      });
    });
  });

  it("keeps upload drafts scoped to their thread while navigating", async () => {
    const user = userEvent.setup({ delay: null });
    const uploadStarted = context.mocks.deferred<void>();
    let uploadRequest: {
      promise: Promise<Response>;
      resolve: (value: Response) => void;
    } | null = null;

    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockThreadDetails();
    context.mocks.http.post("*/api/zero/uploads/prepare", () => {
      return HttpResponse.json({
        id: "upload-photo",
        filename: "photo.png",
        contentType: "image/png",
        size: 1024,
        uploadUrl: "https://mock-upload.example.com/photo.png",
        url: "https://example.com/photo.png",
      });
    });
    context.mocks.http.put(
      "https://mock-upload.example.com/photo.png",
      ({ deferred }) => {
        uploadStarted.resolve();
        const request = deferred<Response>();
        uploadRequest = {
          promise: request.promise,
          resolve: request.resolve,
        };
        return request.promise;
      },
    );

    detachedSetupPage({ context, path: "/chats/thread-1" });

    await waitFor(() => {
      expect(textarea()).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["img-data"], "photo.png", { type: "image/png" }),
    );
    await uploadStarted.promise;

    await waitFor(() => {
      expect(
        screen.getByLabelText("Cancel upload photo.png"),
      ).toBeInTheDocument();
    });

    await navigateToThread("thread-2");
    await waitFor(() => {
      expect(textarea()).toHaveValue("");
      expect(screen.queryByLabelText(/photo\.png/)).not.toBeInTheDocument();
    });

    uploadRequest!.resolve(new HttpResponse(null, { status: 200 }));

    await navigateToThread("thread-1");
    await waitFor(() => {
      expect(screen.getByLabelText("Remove photo.png")).toBeInTheDocument();
    });
  });

  it("removes failed upload chips and leaves remaining draft attachments sendable", async () => {
    const user = userEvent.setup({ delay: null });

    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockThreadDetails();
    context.mocks.http.post(
      "*/api/zero/uploads/prepare",
      async ({ request }) => {
        const body = (await request.json()) as { filename: string };
        if (body.filename === "ok.txt") {
          return HttpResponse.json({
            id: "upload-ok",
            filename: "ok.txt",
            contentType: "text/plain",
            size: 2,
            uploadUrl: "https://mock-upload.example.com/ok.txt",
            url: "https://example.com/ok.txt",
          });
        }
        return HttpResponse.json({
          id: "upload-failed",
          filename: "failed.txt",
          contentType: "text/plain",
          size: 6,
          uploadUrl: "https://mock-upload.example.com/failed.txt",
          url: "https://example.com/failed.txt",
        });
      },
    );
    context.mocks.http.put("https://mock-upload.example.com/ok.txt", () => {
      return new HttpResponse(null, { status: 200 });
    });
    context.mocks.http.put("https://mock-upload.example.com/failed.txt", () => {
      return new HttpResponse(null, { status: 500 });
    });

    detachedSetupPage({ context, path: "/chats/thread-uploads" });

    await waitFor(() => {
      expect(textarea()).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(fileInput, [
      new File(["ok"], "ok.txt", { type: "text/plain" }),
      new File(["failed"], "failed.txt", { type: "text/plain" }),
    ]);

    await waitFor(() => {
      expect(
        screen.getByText("Failed to upload failed.txt"),
      ).toBeInTheDocument();
      expect(screen.queryByTitle("failed.txt")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Remove ok.txt")).toBeInTheDocument();
    });
  });

  it("infers attachment content type when the browser reports a generic file type", async () => {
    const user = userEvent.setup({ delay: null });
    let capturedPrepareBody: unknown = null;

    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockThreadDetails();
    context.mocks.http.post(
      "*/api/zero/uploads/prepare",
      async ({ request }) => {
        capturedPrepareBody = await request.json();
        return HttpResponse.json({
          id: "upload-launch-plan",
          filename: "launch-plan.pdf",
          contentType: "application/pdf",
          size: 11,
          uploadUrl: "https://mock-upload.example.com/launch-plan.pdf",
          url: "https://example.com/launch-plan.pdf",
        });
      },
    );
    context.mocks.http.put(
      "https://mock-upload.example.com/launch-plan.pdf",
      () => {
        return new HttpResponse(null, { status: 200 });
      },
    );

    detachedSetupPage({ context, path: "/chats/thread-uploads" });

    await waitFor(() => {
      expect(textarea()).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["release pdf"], "launch-plan.pdf", {
        type: "application/octet-stream",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Remove launch-plan.pdf"),
      ).toBeInTheDocument();
      expect(capturedPrepareBody).toMatchObject({
        filename: "launch-plan.pdf",
        contentType: "application/pdf",
      });
    });
  });

  it("uploads dropped files and reports oversized drops", async () => {
    const threadId = "thread-uploads";
    const oversizedFile = new File(["video"], "launch-recording.mov", {
      type: "video/quicktime",
    });
    Object.defineProperty(oversizedFile, "size", {
      value: 1024 * 1024 * 1024 + 1,
    });

    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockThreadDetails();
    context.mocks.upload.success({
      id: "drop-notes-upload",
      filename: "drop-notes.txt",
      contentType: "text/plain",
      size: 10,
      url: "https://example.com/drop-notes.txt",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const input = await waitFor(() => {
      return textarea();
    });

    fireEvent.drop(input, {
      dataTransfer: {
        files: [
          new File(["drop notes"], "drop-notes.txt", { type: "text/plain" }),
          oversizedFile,
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Remove drop-notes.txt"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("launch-recording.mov exceeds the 1 GB limit"),
      ).toBeInTheDocument();
    });
  });

  it("restores copied chat text and attachments from the clipboard", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-copied-attachment";
    const pastedText = "Please use the copied brief";
    const filename = "product-brief.md";

    mockChatLifecycle(context, { threadId });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const input = await waitFor(() => {
      return textarea();
    });
    await user.click(input);

    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => {
          if (type === "text/html") {
            return chatClipboardHtml({
              text: pastedText,
              attachments: [
                {
                  id: "copied-brief",
                  url: "https://cdn.vm7.io/artifacts/test/copied-brief/product-brief.md",
                  filename,
                  contentType: "text/markdown",
                  size: 42,
                },
              ],
            });
          }
          return "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      expect(input).toHaveValue(pastedText);
      expect(screen.getByLabelText(`Remove ${filename}`)).toBeInTheDocument();
    });
  });
});
