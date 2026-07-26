import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@vm0/ui/components/ui/sonner";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@vm0/core";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroAgentsByIdContract,
  zeroAgentDraftContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { zeroWorkflowsCollectionContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage as baseDetachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ONE_ID = "b0000000-0000-4000-a000-000000000801";
const THREAD_TWO_ID = "b0000000-0000-4000-a000-000000000802";
const THREAD_UPLOADS_ID = "b0000000-0000-4000-a000-000000000803";

function detachedSetupPage(
  options: Parameters<typeof baseDetachedSetupPage>[0],
): void {
  baseDetachedSetupPage(options);
}

function mockThreadDetails(): void {
  const threads = [
    {
      id: THREAD_ONE_ID,
      title: "Thread 1",
      agent: {
        id: "c0000000-0000-4000-a000-000000000001",
        avatarUrl: null,
      },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    },
    {
      id: THREAD_TWO_ID,
      title: "Thread 2",
      agent: {
        id: "c0000000-0000-4000-a000-000000000001",
        avatarUrl: null,
      },
      createdAt: "2026-03-10T00:01:00Z",
      updatedAt: "2026-03-10T00:01:00Z",
    },
    {
      id: THREAD_UPLOADS_ID,
      title: "Uploads",
      agent: {
        id: "c0000000-0000-4000-a000-000000000001",
        avatarUrl: null,
      },
      createdAt: "2026-03-10T00:02:00Z",
      updatedAt: "2026-03-10T00:02:00Z",
    },
  ];
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threads.map((thread) => {
        return {
          id: thread.id,
          agentId: thread.agent.id,
          title: thread.title,
          sortAt: thread.updatedAt,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        };
      }),
      latestEventId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
    });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftContent: null,
      draftAttachments: null,
    });
  });
}

function textarea(): HTMLElement {
  const editor = document.querySelector(
    '.zero-composer [contenteditable="true"]',
  );
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Composer editor not found");
  }
  return editor;
}

function mockAgentChatPage(agentId: string): void {
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-4-6",
    updatedAt: "2026-03-10T00:00:00Z",
  });
  context.mocks.api(zeroTeamContract.list, ({ respond }) => {
    return respond(200, [
      {
        id: agentId,
        displayName: "Draft Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
  });
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      agentId: params.id,
      ownerId: "test-user-123",
      description: null,
      displayName: "Draft Agent",
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
  });
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

async function findComposerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '.zero-composer [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

async function navigateToThread(threadId: string): Promise<void> {
  const link = await waitFor(() => {
    return document.querySelector<HTMLAnchorElement>(
      `a[href="/chats/${threadId}"]`,
    );
  });
  if (!link) {
    throw new Error(`Thread link not found: ${threadId}`);
  }
  click(link);
}

describe("chat drafts", () => {
  it("restores a saved agent draft with attachments on first agent chat open", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000101";
    mockAgentChatPage(agentId);
    context.mocks.api(zeroAgentDraftContract.get, ({ params, respond }) => {
      return respond(200, {
        draftContent: `Resume the ${params.id} launch notes`,
        draftAttachments: [
          {
            id: "agent-draft-brief",
            filename: "agent-brief.md",
            contentType: "text/markdown",
            size: 64,
            url: "https://cdn.vm7.io/artifacts/test/drafts/agent-brief.md",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await waitFor(() => {
      expect(textarea()).toHaveTextContent(
        `Resume the ${agentId} launch notes`,
      );
      expect(
        screen.getByLabelText("Remove agent-brief.md"),
      ).toBeInTheDocument();
    });
  });

  it("restores a structured agent draft instead of stale legacy state", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000111";
    const referencedThreadId = "b1000000-0000-4000-a000-000000000111";
    const firstAttachment = {
      id: "agent-draft-first",
      filename: "first.txt",
      contentType: "text/plain",
      size: 5,
      url: "https://cdn.vm7.io/artifacts/test/drafts/first.txt",
    };
    const secondAttachment = {
      id: "agent-draft-second",
      filename: "second.txt",
      contentType: "text/plain",
      size: 6,
      url: "https://cdn.vm7.io/artifacts/test/drafts/second.txt",
    };
    mockAgentChatPage(agentId);
    context.mocks.api(zeroAgentDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftContent: "stale legacy agent draft",
        draftStructuredPrompt: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: secondAttachment.id,
              filenameSnapshot: secondAttachment.filename,
              contentType: secondAttachment.contentType,
            },
            {
              type: "file",
              fileId: firstAttachment.id,
              filenameSnapshot: firstAttachment.filename,
              contentType: firstAttachment.contentType,
            },
            { type: "text", text: "Review " },
            {
              type: "chat_thread",
              threadId: referencedThreadId,
              titleSnapshot: "Launch research",
            },
            { type: "text", text: " now" },
          ],
        },
        draftAttachments: [firstAttachment, secondAttachment],
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    const editor = await findComposerEditor();
    await waitFor(() => {
      expect(editor).toHaveTextContent("Review Launch research now");
      expect(editor).not.toHaveTextContent("stale legacy agent draft");
      expect(
        editor.querySelector(
          `span[data-chat-thread-mention="${referencedThreadId}"]`,
        ),
      ).toHaveTextContent("Launch research");
      expect(
        queryAllByRoleFast("button")
          .filter((button) => {
            return /^Remove (?:first|second)\.txt$/.test(
              button.getAttribute("aria-label") ?? "",
            );
          })
          .map((button) => {
            return button.getAttribute("aria-label");
          }),
      ).toStrictEqual(["Remove second.txt", "Remove first.txt"]);
    });
  });

  it("persists and clears typed agent drafts through the agent draft endpoint", async () => {
    const user = userEvent.setup({ delay: null });
    const agentId = "c0000000-0000-4000-a000-000000000102";
    const draftPatches: Record<string, unknown>[] = [];
    const toastError = vi.spyOn(toast, "error");
    mockAgentChatPage(agentId);
    context.mocks.api(zeroAgentDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftContent: null,
        draftAttachments: null,
      });
    });
    context.mocks.http.patch(
      "*/api/zero/agents/:id/draft",
      async ({ request }) => {
        draftPatches.push((await request.json()) as Record<string, unknown>);
        return new Response(null, { status: 200 });
      },
    );

    try {
      detachedSetupPage({
        context,
        path: `/agents/${agentId}/chat`,
        featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
      });

      await waitFor(() => {
        expect(textarea()).toBeInTheDocument();
      });
      await fill(textarea(), "agent-level draft");

      await waitFor(() => {
        expect(draftPatches).toContainEqual({
          draftContent: "agent-level draft",
          draftStructuredPrompt: {
            version: 1,
            parts: [{ type: "text", text: "agent-level draft" }],
          },
          draftAttachments: null,
        });
      });

      await user.click(textarea());
      await user.keyboard("{Control>}a{/Control}{Backspace}");

      await waitFor(() => {
        expect(draftPatches).toContainEqual({
          draftContent: null,
          draftStructuredPrompt: null,
          draftAttachments: null,
        });
      });
      expect(textarea().textContent ?? "").toBe("");
      await Promise.resolve();
      await Promise.resolve();
      expect(toastError).not.toHaveBeenCalledWith("HTTP 200");
    } finally {
      toastError.mockRestore();
    }
  });

  it("persists and clears typed thread drafts when structured prompts are enabled", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b1000000-0000-4000-a000-000000000107";
    const draftPatches: Record<string, unknown>[] = [];
    mockChatLifecycle(context, { threadId });
    context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
      draftPatches.push(body as Record<string, unknown>);
      return respond(204);
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    const editor = await findComposerEditor();
    await fill(editor, "thread-level draft");

    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftContent: "thread-level draft",
        draftStructuredPrompt: {
          version: 1,
          parts: [{ type: "text", text: "thread-level draft" }],
        },
        draftAttachments: null,
      });
    });

    await user.click(editor);
    await user.keyboard("{Control>}a{/Control}{Backspace}");

    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftContent: null,
        draftStructuredPrompt: null,
        draftAttachments: null,
      });
    });
    expect(editor.textContent ?? "").toBe("");
  });

  it("preserves per-thread text drafts while navigating", async () => {
    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockThreadDetails();

    detachedSetupPage({ context, path: `/chats/${THREAD_ONE_ID}` });

    await waitFor(() => {
      expect(textarea()).toBeInTheDocument();
    });
    await fill(textarea(), "draft for thread 1");

    await navigateToThread(THREAD_TWO_ID);
    await waitFor(() => {
      expect(textarea().textContent ?? "").toBe("");
    });
    await fill(textarea(), "draft for thread 2");

    await navigateToThread(THREAD_ONE_ID);
    await waitFor(() => {
      expect(textarea()).toHaveTextContent("draft for thread 1");
    });

    await navigateToThread(THREAD_TWO_ID);
    await waitFor(() => {
      expect(textarea()).toHaveTextContent("draft for thread 2");
    });
  });

  it("restores a saved server draft with attachments on first thread open", async () => {
    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockThreadDetails();
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
      return respond(200, {
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
      });
    });

    detachedSetupPage({ context, path: "/chats/thread-server-draft" });

    await waitFor(() => {
      expect(textarea()).toHaveTextContent("Review the saved launch brief");
      expect(screen.getByLabelText("Remove brief.md")).toBeInTheDocument();
    });
  });

  it("restores and persists the structured draft when the switch is enabled", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b1000000-0000-4000-a000-000000000104";
    const referencedThreadId = "b1000000-0000-4000-a000-000000000105";
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const draftPatches: Record<string, unknown>[] = [];
    const secondAttachment = {
      id: "draft-second",
      filename: "second.txt",
      contentType: "text/plain",
      size: 6,
      url: "https://cdn.vm7.io/artifacts/test/drafts/second.txt",
    };
    const firstAttachment = {
      id: "draft-first",
      filename: "first.txt",
      contentType: "text/plain",
      size: 5,
      url: "https://cdn.vm7.io/artifacts/test/drafts/first.txt",
    };
    const template = {
      type: "illustration" as const,
      selection: {
        illustrationStyleId: illustrationTemplate.illustrationStyleId,
      },
    };

    mockChatLifecycle(context, { threadId });
    context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftContent: "stale legacy draft",
        draftStructuredPrompt: {
          version: 1,
          parts: [
            {
              type: "template",
              titleSnapshot: illustrationTemplate.title,
              template,
            },
            {
              type: "file",
              fileId: secondAttachment.id,
              filenameSnapshot: secondAttachment.filename,
              contentType: secondAttachment.contentType,
            },
            {
              type: "file",
              fileId: firstAttachment.id,
              filenameSnapshot: firstAttachment.filename,
              contentType: firstAttachment.contentType,
            },
            { type: "text", text: "Review " },
            {
              type: "chat_thread",
              threadId: referencedThreadId,
              titleSnapshot: "Launch research",
            },
            { type: "text", text: " now" },
          ],
        },
        draftAttachments: [firstAttachment, secondAttachment],
      });
    });
    context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
      draftPatches.push(body as Record<string, unknown>);
      return respond(204);
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    const editor = await findComposerEditor();
    await waitFor(() => {
      expect(editor).toHaveTextContent("Review Launch research now");
      expect(
        editor.querySelector(
          `span[data-chat-thread-mention="${referencedThreadId}"]`,
        ),
      ).toHaveTextContent("Launch research");
      expect(
        screen.getByLabelText(`Remove template ${illustrationTemplate.title}`),
      ).toBeInTheDocument();
      expect(
        queryAllByRoleFast("button")
          .filter((button) => {
            return /^Remove (?:first|second)\.txt$/.test(
              button.getAttribute("aria-label") ?? "",
            );
          })
          .map((button) => {
            return button.getAttribute("aria-label");
          }),
      ).toStrictEqual(["Remove second.txt", "Remove first.txt"]);
    });

    await user.click(screen.getByLabelText("Remove first.txt"));

    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftContent: `Review [Launch research](/chats/${referencedThreadId}) now`,
        draftStructuredPrompt: {
          version: 1,
          parts: [
            {
              type: "template",
              titleSnapshot: illustrationTemplate.title,
              template,
            },
            {
              type: "file",
              fileId: secondAttachment.id,
              filenameSnapshot: secondAttachment.filename,
              contentType: secondAttachment.contentType,
            },
            { type: "text", text: "Review " },
            {
              type: "chat_thread",
              threadId: referencedThreadId,
              titleSnapshot: "Launch research",
            },
            { type: "text", text: " now" },
          ],
        },
        draftAttachments: [secondAttachment],
      });
    });
  });

  it("keeps legacy draft hydration and clears structured state when the switch is disabled", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b1000000-0000-4000-a000-000000000106";
    const draftPatches: Record<string, unknown>[] = [];
    const legacyAttachment = {
      id: "legacy-draft-file",
      filename: "legacy.txt",
      contentType: "text/plain",
      size: 6,
      url: "https://cdn.vm7.io/artifacts/test/drafts/legacy.txt",
    };

    mockChatLifecycle(context, { threadId });
    context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
      return respond(200, {
        draftContent: "legacy draft",
        draftStructuredPrompt: {
          version: 1,
          parts: [{ type: "text", text: "structured draft" }],
        },
        draftAttachments: [legacyAttachment],
      });
    });
    context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
      draftPatches.push(body as Record<string, unknown>);
      return respond(204);
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: false },
    });

    const editor = await findComposerEditor();
    await waitFor(() => {
      expect(editor).toHaveTextContent("legacy draft");
      expect(editor).not.toHaveTextContent("structured draft");
      expect(screen.getByLabelText("Remove legacy.txt")).toBeInTheDocument();
    });

    await user.click(editor);
    await user.keyboard(" updated");

    await waitFor(() => {
      expect(draftPatches).toContainEqual({
        draftContent: "legacy draft updated",
        draftStructuredPrompt: null,
        draftAttachments: [legacyAttachment],
      });
    });
  });

  it("persists edited draft attachments and clears the server draft after sending", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b1000000-0000-4000-a000-000000000102";
    const draftPatches: Record<string, unknown>[] = [];
    mockChatLifecycle(context, { threadId });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
      return respond(200, {
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
      expect(textarea()).toHaveTextContent("Review the saved launch brief");
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
        draftStructuredPrompt: null,
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
      expect(textarea().textContent ?? "").toBe("");
      expect(draftPatches).toContainEqual({
        draftContent: null,
        draftStructuredPrompt: null,
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

    detachedSetupPage({ context, path: `/chats/${THREAD_ONE_ID}` });

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

    await navigateToThread(THREAD_TWO_ID);
    await waitFor(() => {
      expect(textarea().textContent ?? "").toBe("");
      expect(screen.queryByLabelText(/photo\.png/)).not.toBeInTheDocument();
    });

    uploadRequest!.resolve(new HttpResponse(null, { status: 200 }));

    await navigateToThread(THREAD_ONE_ID);
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

    detachedSetupPage({ context, path: `/chats/${THREAD_UPLOADS_ID}` });

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

    detachedSetupPage({ context, path: `/chats/${THREAD_UPLOADS_ID}` });

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
    const threadId = THREAD_UPLOADS_ID;
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

  it("keeps pasted plain text inline at the caret", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-plain-text-paste";

    mockChatLifecycle(context, { threadId });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("Before after");
    await user.keyboard(
      "{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}",
    );

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/plain" ? "pasted " : "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      expect(
        Array.from(editor.children, (element) => {
          return element.textContent ?? "";
        }).filter((text) => {
          return text.length > 0;
        }),
      ).toStrictEqual(["Before pasted after"]);
    });
  });

  it("joins multiline prompt items only at the paste boundaries", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-multiline-paste";

    mockChatLifecycle(context, { threadId });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("Before after");
    await user.keyboard(
      "{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}",
    );

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/plain"
            ? `first\n[Thread 1](/chats/${THREAD_ONE_ID})\nlast `
            : "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      expect(
        Array.from(editor.children, (element) => {
          return element.textContent ?? "";
        }).filter((text) => {
          return text.length > 0;
        }),
      ).toStrictEqual(["Before first", "Thread 1", "last after"]);
      expect(
        editor.querySelector(
          `span[data-chat-thread-mention="${THREAD_ONE_ID}"]`,
        ),
      ).toHaveTextContent("Thread 1");
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
      expect(input).toHaveTextContent(pastedText);
      expect(screen.getByLabelText(`Remove ${filename}`)).toBeInTheDocument();
    });
  });

  it("falls back to plain text when copied chat html only carries attachments", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-copied-attachment-plain-fallback";
    const pastedText = "123";
    const filename = "image.png";
    const url =
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8e2a2ad0-da8a-4ee7-8494-e0d7f6d87360/image.png";

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
              text: "",
              attachments: [
                {
                  id: "copied-image",
                  url,
                  filename,
                  contentType: "image/png",
                  size: 42,
                },
              ],
            });
          }
          if (type === "text/plain") {
            return [
              pastedText,
              "",
              "Attachments:",
              `- [${filename}](${url}): ${url}`,
            ].join("\n");
          }
          return "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      expect(input).toHaveTextContent(pastedText);
      expect(screen.getByLabelText(`Remove ${filename}`)).toBeInTheDocument();
    });
  });

  it("preserves multiline copied chat text when attachments prevent default paste", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-copied-attachment-slash-composer";
    const pastedText = `first\n[Thread 1](/chats/${THREAD_ONE_ID})\nlast `;
    const filename = "image.png";
    const url =
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8e2a2ad0-da8a-4ee7-8494-e0d7f6d87360/image.png";

    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, []);
    });
    mockChatLifecycle(context, { threadId });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("Before after");
    await user.keyboard(
      "{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}",
    );

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => {
          if (type === "text/html") {
            return chatClipboardHtml({
              text: pastedText,
              attachments: [
                {
                  id: "copied-image",
                  url,
                  filename,
                  contentType: "image/png",
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
      expect(
        Array.from(editor.children, (element) => {
          return element.textContent ?? "";
        }).filter((text) => {
          return text.length > 0;
        }),
      ).toStrictEqual(["Before first", "Thread 1", "last after"]);
      expect(
        editor.querySelector(
          `span[data-chat-thread-mention="${THREAD_ONE_ID}"]`,
        ),
      ).toHaveTextContent("Thread 1");
      expect(screen.getByLabelText(`Remove ${filename}`)).toBeInTheDocument();
    });
  });
});
