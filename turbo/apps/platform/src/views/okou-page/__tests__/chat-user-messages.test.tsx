import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { browserContract } from "@okouai/api-contracts/contracts/browser";

import {
  detachedSetupPage,
  queryAllByRoleFast,
  setupPageAndWaitForContent,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";

const context = testContext();

function linkByAriaLabel(label: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((element) => {
    return element.getAttribute("aria-label") === label;
  });
  if (!link) {
    throw new Error(`Expected link with aria-label: ${label}`);
  }
  return link;
}

describe("user messages", () => {
  it("renders templates inline in message and feedback-note order", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000748";
    const templateItem = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const template = {
      type: "illustration" as const,
      selection: {
        illustrationStyleId: templateItem.illustrationStyleId,
      },
    };
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Inline template rendering",
      chatEvents: [
        {
          id: "00000000-0000-4000-8000-000000000748",
          role: "user",
          content: "Legacy body stays hidden",
          runId: "d0000000-0000-4000-a000-000000000748",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Before " },
              {
                type: "template",
                titleSnapshot: templateItem.title,
                template,
              },
              { type: "text", text: " after" },
              {
                type: "feedback",
                quote: "Earlier answer",
                note: [
                  { type: "text", text: "Restyle with " },
                  {
                    type: "template",
                    titleSnapshot: templateItem.title,
                    template,
                  },
                ],
              },
            ],
          },
          createdAt: "2026-07-27T10:00:00Z",
        },
      ],
    });

    await setupPageAndWaitForContent({
      context,
      path: `/chats/${threadId}`,
    });

    const userMessageElement = await waitFor(() => {
      const element = document.querySelector("[data-structured-user-message]");
      expect(element).toBeInstanceOf(HTMLElement);
      return element as HTMLElement;
    });
    const references = screen.getAllByTitle(
      `Illustration · ${templateItem.title}`,
    );
    expect(references).toHaveLength(2);
    const buttons = queryAllByRoleFast("button");
    for (const reference of references) {
      expect(reference.textContent).toBe(templateItem.title);
      // A sent template is a record, not a control, so it exposes no button.
      expect(buttons).not.toContain(reference);
    }
    const feedback = document.querySelector("[data-structured-feedback-group]");
    expect(feedback).toBeInstanceOf(HTMLElement);
    expect(feedback).toContainElement(references[1]);
    expect(userMessageElement.textContent).toContain(
      `Before ${templateItem.title} after`,
    );
    expect(feedback).toHaveTextContent(`Restyle with ${templateItem.title}`);

    await user.click(references[0]!);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders ordered canonical snapshots with literal Markdown text", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000741";
    const referencedThreadId = "b0000000-0000-4000-a000-000000000742";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured message rendering",
      chatEvents: [
        {
          id: "00000000-0000-4000-8000-000000000741",
          role: "user",
          content: null,
          runId: "d0000000-0000-4000-a000-000000000741",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "template",
                titleSnapshot: "Archived deck",
                template: {
                  type: "presentation",
                  selection: { templateId: "retired-template" },
                },
              },
              {
                type: "file",
                fileId: "image-live",
                filenameSnapshot: "reference.png",
                contentType: "image/png",
              },
              { type: "text", text: "Start " },
              {
                type: "chat_thread",
                threadId: referencedThreadId,
                titleSnapshot: "Archived source",
              },
              { type: "text", text: " with " },
              {
                type: "file",
                fileId: "file-live",
                filenameSnapshot: "original-report.pdf",
                contentType: "application/pdf",
              },
              { type: "text", text: ", then " },
              {
                type: "file",
                fileId: "file-deleted",
                filenameSnapshot: "deleted-notes.txt",
                contentType: "text/plain",
              },
              { type: "text", text: ".\nUse **literal** <span>." },
            ],
          },
          createdAt: "2026-07-21T10:00:00Z",
        },
        {
          id: "00000000-0000-4000-8000-000000000743",
          role: "user",
          content: "Legacy text stays hidden",
          runId: "d0000000-0000-4000-a000-000000000743",
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Canonical **bold** remains" }],
          },
          createdAt: "2026-07-21T10:01:00Z",
        },
        {
          id: "00000000-0000-4000-8000-000000000744",
          role: "user",
          content: "Migrated **literal** text",
          runId: "d0000000-0000-4000-a000-000000000744",
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Migrated **literal** text" }],
          },
          createdAt: "2026-07-21T10:02:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const userMessageElement = await waitFor(() => {
      const element = document.querySelector("[data-structured-user-message]");
      expect(element).toBeInstanceOf(HTMLElement);
      return element as HTMLElement;
    });
    expect(userMessageElement.textContent).toBe(
      "Archived deckStart Archived source with , then .\n" +
        "Use **literal** <span>.",
    );
    expect(userMessageElement.querySelector("strong")).toBeNull();

    const threadLink = userMessageElement.querySelector(
      'a[aria-label="Open chat Archived source"]',
    );
    expect(threadLink).toHaveAttribute("href", `/chats/${referencedThreadId}`);
    const template = screen.getByTitle("Presentation · Archived deck");
    const image = screen.getByLabelText("Preview reference.png");
    expect(image).toBeInTheDocument();
    // Templates render inline at their position in the message, so the chip
    // stays inside the bubble instead of being elevated above it.
    expect(userMessageElement).toContainElement(template);
    expect(
      image.compareDocumentPosition(userMessageElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Canonical file parts leave the bubble and keep their persisted snapshot;
    // conflicting legacy response projection metadata is ignored.
    const pdf = screen.getByLabelText(
      "Open pdf preview for original-report.pdf",
    );
    expect(
      within(screen.getByTestId("message-file-attachments")).getByLabelText(
        "Open pdf preview for original-report.pdf",
      ),
    ).toBe(pdf);
    expect(
      pdf.compareDocumentPosition(userMessageElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Open text preview for deleted-notes.txt"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Legacy structured body should stay hidden"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Retired template")).not.toBeInTheDocument();
    expect(screen.queryByText("renamed-report.pdf")).not.toBeInTheDocument();

    const literalMarkdown = await screen.findByText(
      "Canonical **bold** remains",
    );
    expect(literalMarkdown.querySelector("strong")).toBeNull();
    expect(
      screen.queryByText("Legacy text stays hidden"),
    ).not.toBeInTheDocument();
    const migratedLiteralMarkdown = await screen.findByText(
      "Migrated **literal** text",
    );
    expect(migratedLiteralMarkdown.querySelector("strong")).toBeNull();
  });

  it("groups structured feedback and highlights chat thread mentions in notes", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000746";
    const referencedThreadId = "b0000000-0000-4000-a000-000000000747";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured feedback group",
      chatEvents: [
        {
          id: "00000000-0000-4000-8000-000000000746",
          role: "user",
          content: "Legacy feedback stays hidden",
          runId: "d0000000-0000-4000-a000-000000000746",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Before feedback.\n" },
              {
                type: "feedback",
                quote: "The plan needs an owner",
                note: [
                  { type: "text", text: "Name the owner in " },
                  {
                    type: "chat_thread",
                    threadId: referencedThreadId,
                    titleSnapshot: "Project Alpha",
                  },
                  { type: "text", text: "." },
                ],
              },
              {
                type: "feedback",
                quote: "The plan needs milestones",
                note: [
                  { type: "text", text: "Add dates from " },
                  {
                    type: "chat_thread",
                    threadId: referencedThreadId,
                    titleSnapshot: "Project Alpha",
                  },
                  { type: "text", text: "." },
                ],
              },
              { type: "text", text: "\nAfter feedback." },
            ],
          },
          createdAt: "2026-07-26T10:03:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const group = await waitFor(() => {
      const element = document.querySelector(
        "[data-structured-feedback-group]",
      );
      expect(element).toBeInstanceOf(HTMLElement);
      return element as HTMLElement;
    });
    expect(
      screen.getByText("Feedback on 2 parts of your reply:"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Feedback on this part of your reply:"),
    ).not.toBeInTheDocument();
    expect(
      group.querySelectorAll("[data-structured-feedback-quote]"),
    ).toHaveLength(2);
    expect(
      group.querySelectorAll("[data-structured-feedback-divider]"),
    ).toHaveLength(1);
    const links = group.querySelectorAll(
      `a[aria-label="Open chat Project Alpha"]`,
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", `/chats/${referencedThreadId}`);
    expect(group).not.toHaveTextContent(`/chats/${referencedThreadId}`);
    expect(screen.getByText("Before feedback.")).toBeInTheDocument();
    expect(screen.getByText("After feedback.")).toBeInTheDocument();
  });

  it("renders agent mentions as chips in messages and feedback notes", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000749";
    const mentionedAgentId = "a1000000-0000-4000-a000-000000000009";
    const mentionedAgentAvatarUrl = "https://example.com/ada-agent-avatar.png";
    context.mocks.data.agents([
      {
        agentId: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
      },
      {
        agentId: mentionedAgentId,
        displayName: "Ada",
        description: null,
        sound: null,
        avatarUrl: mentionedAgentAvatarUrl,
      },
    ]);
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Agent mention rendering",
      chatEvents: [
        {
          id: "00000000-0000-4000-8000-000000000749",
          role: "user",
          content: `Ask [Ada](/agents/${mentionedAgentId}/chat) about it.`,
          runId: "d0000000-0000-4000-a000-000000000749",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Ask " },
              {
                type: "agent",
                agentId: mentionedAgentId,
                nameSnapshot: "Ada",
              },
              { type: "text", text: " about it." },
              {
                type: "feedback",
                quote: "The rollout needs a reviewer",
                note: [
                  { type: "text", text: "Loop in " },
                  {
                    type: "agent",
                    agentId: mentionedAgentId,
                    nameSnapshot: "Ada",
                  },
                  { type: "text", text: "." },
                ],
              },
            ],
          },
          createdAt: "2026-07-30T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const userMessageElement = await waitFor(() => {
      const element = document.querySelector("[data-structured-user-message]");
      expect(element).toBeInstanceOf(HTMLElement);
      return element as HTMLElement;
    });
    const agentLinks = userMessageElement.querySelectorAll(
      'a[aria-label="Open agent Ada"]',
    );
    expect(agentLinks).toHaveLength(2);
    await waitFor(() => {
      for (const agentLink of agentLinks) {
        expect(agentLink.querySelector("img")).toHaveAttribute(
          "src",
          mentionedAgentAvatarUrl,
        );
      }
    });
    // Avatars are transparent, so any background fill shows through as a gray
    // disc behind the face.
    for (const agentLink of agentLinks) {
      expect(agentLink.querySelector("img")).not.toHaveClass("bg-muted");
    }
    expect(agentLinks[0]).toHaveAttribute(
      "href",
      `/agents/${mentionedAgentId}/chat`,
    );
    expect(agentLinks[0]).toHaveTextContent("Ada");
    expect(userMessageElement).not.toHaveTextContent(
      `/agents/${mentionedAgentId}/chat`,
    );
    expect(
      userMessageElement.querySelector("[data-structured-feedback-group]"),
    ).toBeInstanceOf(HTMLElement);
  });

  it("renders agent-run source annotations with avatar, link, and run anchor", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000750";
    const sourceThreadId = "b0000000-0000-4000-a000-000000000751";
    const sourceRunId = "d0000000-0000-4000-a000-000000000751";
    const targetRunId = "d0000000-0000-4000-a000-000000000750";
    const sourceAgentId = "a1000000-0000-4000-a000-000000000010";
    const sourceAgentAvatarUrl = "https://example.com/source-agent-avatar.png";
    context.mocks.data.agents([
      {
        agentId: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
      },
      {
        agentId: sourceAgentId,
        displayName: "Source agent",
        description: null,
        sound: null,
        avatarUrl: sourceAgentAvatarUrl,
      },
    ]);
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Delegated work",
      chatEvents: [
        {
          id: "00000000-0000-4000-8000-000000000750",
          role: "user",
          content: "Delegated prompt",
          runId: targetRunId,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Delegated prompt" },
              {
                type: "source",
                kind: "agent",
                runId: sourceRunId,
                threadId: sourceThreadId,
                agentId: sourceAgentId,
                titleSnapshot: "Source thread",
                href: `/chats/${sourceThreadId}#run-${sourceRunId}`,
              },
            ],
          },
          createdAt: "2026-08-04T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const sourceLink = await waitFor(() => {
      return linkByAriaLabel("Open chat Source thread");
    });
    expect(sourceLink).toHaveAttribute(
      "href",
      `/chats/${sourceThreadId}#run-${sourceRunId}`,
    );
    await waitFor(() => {
      expect(sourceLink.querySelector("img")).toHaveAttribute(
        "src",
        sourceAgentAvatarUrl,
      );
    });
    // Avatars are transparent, so any background fill shows through as a gray
    // disc behind the face.
    expect(sourceLink.querySelector("img")).not.toHaveClass("bg-muted");
    expect(document.getElementById(`run-${targetRunId}`)).toHaveAttribute(
      "data-role",
      "user",
    );
  });

  it("restores cached agent source annotations after browser back from agents", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000752";
    const sourceThreadId = "b0000000-0000-4000-a000-000000000753";
    const sourceRunId = "d0000000-0000-4000-a000-000000000753";
    const sourceAgentId = "a1000000-0000-4000-a000-000000000011";
    context.mocks.data.agents([
      {
        agentId: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
      },
      {
        agentId: sourceAgentId,
        displayName: "Source agent",
        description: null,
        sound: null,
        avatarUrl: "https://example.com/source-agent-avatar.png",
      },
    ]);
    context.mocks.api(logsListContract.list, ({ respond }) => {
      return respond(200, {
        data: [],
        pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
        filters: { statuses: [], sources: [], agents: [] },
      });
    });
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Delegated work",
      chatEvents: [
        {
          id: "00000000-0000-4000-8000-000000000752",
          role: "user",
          content: "Delegated prompt",
          runId: "d0000000-0000-4000-a000-000000000752",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Delegated prompt" },
              {
                type: "source",
                kind: "agent",
                runId: sourceRunId,
                threadId: sourceThreadId,
                agentId: sourceAgentId,
                titleSnapshot: "Source thread",
                href: `/chats/${sourceThreadId}#run-${sourceRunId}`,
              },
            ],
          },
          createdAt: "2026-08-04T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      return linkByAriaLabel("Open chat Source thread");
    });

    const agentsLink = await waitFor(() => {
      const link = within(screen.getByTestId("labeled-nav-rail"))
        .getByText("Agents")
        .closest("a");
      if (!link) {
        throw new Error("Expected the Agents navigation link");
      }
      return link;
    });
    await user.click(agentsLink);
    await screen.findByRole("heading", { name: "Agents" });

    act(() => {
      window.history.back();
    });

    await waitFor(() => {
      return linkByAriaLabel("Open chat Source thread");
    });
    expect(
      screen.queryByText("Oops! Something went sideways"),
    ).not.toBeInTheDocument();
  });

  it("keeps structured message cards while opening a chat sidebar through navigation", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000754";
    const sidebarThreadId = "b0000000-0000-4000-a000-000000000755";
    const sourceThreadId = "b0000000-0000-4000-a000-000000000756";
    const sourceRunId = "d0000000-0000-4000-a000-000000000756";
    const sourceAgentId = "a1000000-0000-4000-a000-000000000012";
    const createdAt = "2026-08-04T10:00:00Z";
    context.mocks.data.agents([
      {
        agentId: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
      },
      {
        agentId: sourceAgentId,
        displayName: "Source agent",
        description: null,
        sound: null,
        avatarUrl: "https://example.com/source-agent-avatar.png",
      },
    ]);
    context.mocks.api(browserContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "BROWSER_NOT_FOUND", message: "Browser not found" },
      });
    });
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      threadTitle: "Delegated work",
      chatEvents: [],
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: "Delegated work",
        agent: {
          id: "c0000000-0000-4000-a000-000000000001",
          avatarUrl: null,
        },
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: sidebarThreadId,
        title: "Sidebar chat",
        agent: {
          id: "c0000000-0000-4000-a000-000000000001",
          avatarUrl: null,
        },
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    const sourceEvents = normalizeMockChatEvents([
      {
        id: "00000000-0000-4000-8000-000000000754",
        threadId,
        role: "user",
        content: "Delegated prompt",
        runId: "d0000000-0000-4000-a000-000000000754",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Delegated prompt" },
            {
              type: "source",
              kind: "agent",
              runId: sourceRunId,
              threadId: sourceThreadId,
              agentId: sourceAgentId,
              titleSnapshot: "Source thread",
              href: `/chats/${sourceThreadId}#run-${sourceRunId}`,
            },
            {
              type: "file",
              fileId: "file-source-context",
              filenameSnapshot: "source-context.bin",
              contentType: "application/octet-stream",
            },
          ],
        },
        createdAt,
      },
    ]);
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ params, query, respond }) => {
        if (params.threadId !== threadId) {
          return respond(200, chatEventRowsResponse([], query));
        }
        return respond(
          200,
          chatEventRowsResponse(
            mockChatEventRows(sourceEvents).filter((row) => {
              return row.seqId > query.sinceSeqId;
            }),
            query,
          ),
        );
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      return linkByAriaLabel("Open chat Source thread");
    });
    expect(screen.getAllByText("source-context.bin").length).toBeGreaterThan(0);

    const sidebarThreadLink = await waitFor(() => {
      const link = within(screen.getByTestId("chat-list-column"))
        .getByText("Sidebar chat")
        .closest("a");
      if (!link) {
        throw new Error("Expected the sidebar thread link");
      }
      return link;
    });
    fireEvent.click(sidebarThreadLink, { altKey: true });

    await waitFor(() => {
      expect(screen.getAllByLabelText("Chat thread")).toHaveLength(2);
    });
    await waitFor(() => {
      return linkByAriaLabel("Open chat Source thread");
    });
    expect(screen.getAllByText("source-context.bin").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("Oops! Something went sideways"),
    ).not.toBeInTheDocument();
  });

  it("renders Morning Brief metadata outside the message body", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000760";
    const prompt = "Generate my Morning Brief for 2026-08-05.";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Morning Brief",
      chatEvents: [
        {
          id: "00000000-0000-4000-8000-000000000760",
          role: "user",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: prompt },
              { type: "morning_brief", briefDate: "2026-08-05" },
            ],
          },
          createdAt: "2026-08-05T07:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const annotation = await screen.findByLabelText("Morning Brief");
    const messageBody = await waitFor(() => {
      const element = document.querySelector("[data-structured-user-message]");
      expect(element).toBeInstanceOf(HTMLElement);
      return element as HTMLElement;
    });
    expect(messageBody.textContent).toBe(prompt);
    expect(messageBody).not.toContainElement(annotation);
  });
});
