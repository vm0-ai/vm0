import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@vm0/core";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

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

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
      },
    });

    const userMessageElement = await waitFor(() => {
      const element = document.querySelector("[data-structured-user-message]");
      expect(element).toBeInstanceOf(HTMLElement);
      return element as HTMLElement;
    });
    const references = screen.getAllByLabelText(
      `Message template ${templateItem.title}`,
    );
    expect(references).toHaveLength(2);
    for (const reference of references) {
      expect(reference.tagName).toBe("BUTTON");
      expect(reference).toHaveAttribute("aria-haspopup", "dialog");
      expect(reference).toHaveAttribute(
        "data-structured-template-reference",
        "",
      );
      expect(reference.textContent).toBe(templateItem.title);
    }
    const feedback = document.querySelector("[data-structured-feedback-group]");
    expect(feedback).toBeInstanceOf(HTMLElement);
    expect(feedback).toContainElement(references[1]);
    expect(userMessageElement.textContent).toContain(
      `Before ${templateItem.title} after`,
    );
    expect(feedback).toHaveTextContent(`Restyle with ${templateItem.title}`);

    await user.click(references[0]!);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    const illustrationTab = queryAllByRoleFast("tab").find((tab) => {
      return tab.textContent === "Illustration";
    });
    expect(illustrationTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByLabelText(`Select template ${templateItem.title}`),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      document.querySelector("[data-composer-inline-template]"),
    ).toBeNull();
  });

  it("renders ordered snapshots with literal Markdown text", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000741";
    const referencedThreadId = "b0000000-0000-4000-a000-000000000742";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured message rendering",
      chatEvents: [
        {
          id: "00000000-0000-4000-8000-000000000741",
          role: "user",
          content: "Legacy structured body should stay hidden",
          runId: "d0000000-0000-4000-a000-000000000741",
          generationTemplate: {
            type: "presentation",
            selection: { templateId: "retired-template" },
          },
          attachFiles: [
            {
              id: "image-live",
              filename: "reference.png",
              url: "/f/test-user/image-live/reference.png",
              contentType: "image/png",
              size: 84,
            },
            {
              id: "file-live",
              filename: "renamed-report.pdf",
              url: "/f/test-user/file-live/renamed-report.pdf",
              contentType: "application/pdf",
              size: 42,
            },
          ],
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
      "Start Archived source with PDForiginal-report.pdf, then " +
        "TXTdeleted-notes.txt.\n" +
        "Use **literal** <span>.",
    );
    expect(userMessageElement.querySelector("strong")).toBeNull();

    const threadLink = userMessageElement.querySelector(
      'a[aria-label="Open chat Archived source"]',
    );
    expect(threadLink).toHaveAttribute("href", `/chats/${referencedThreadId}`);
    const template = screen.getByLabelText("Message template Archived deck");
    const image = screen.getByLabelText("Preview reference.png");
    expect(template).toBeInTheDocument();
    expect(image).toBeInTheDocument();
    expect(
      template.compareDocumentPosition(userMessageElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      image.compareDocumentPosition(userMessageElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      userMessageElement.querySelector(
        'button[aria-label="Open pdf preview for original-report.pdf"]',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("File deleted-notes.txt")).toBeInTheDocument();
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
    context.mocks.data.team([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: mentionedAgentId,
        displayName: "Ada",
        description: null,
        sound: null,
        avatarUrl: mentionedAgentAvatarUrl,
        headVersionId: "version_2",
        updatedAt: "2024-01-01T00:00:00Z",
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
});
