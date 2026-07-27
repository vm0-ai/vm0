import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@vm0/core";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

describe("structured user messages", () => {
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
      chatMessages: [
        {
          id: "00000000-0000-4000-8000-000000000748",
          role: "user",
          content: "Legacy body stays hidden",
          runId: "d0000000-0000-4000-a000-000000000748",
          structuredPrompt: {
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
        [FeatureSwitchKey.StructuredPrompt]: true,
        [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
      },
    });

    const structuredMessage = await waitFor(() => {
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
    expect(structuredMessage.textContent).toContain(
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

  it("renders ordered snapshots and keeps the legacy Markdown fallback", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000741";
    const referencedThreadId = "b0000000-0000-4000-a000-000000000742";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured message rendering",
      chatMessages: [
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
          structuredPrompt: {
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
          content: "Legacy **bold** remains",
          runId: "d0000000-0000-4000-a000-000000000743",
          createdAt: "2026-07-21T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    const structuredMessage = await waitFor(() => {
      const element = document.querySelector("[data-structured-user-message]");
      expect(element).toBeInstanceOf(HTMLElement);
      return element as HTMLElement;
    });
    expect(structuredMessage.textContent).toBe(
      "Start Archived source with PDForiginal-report.pdf, then " +
        "TXTdeleted-notes.txt.\n" +
        "Use **literal** <span>.",
    );
    expect(structuredMessage.querySelector("strong")).toBeNull();

    const threadLink = structuredMessage.querySelector(
      'a[aria-label="Open chat Archived source"]',
    );
    expect(threadLink).toHaveAttribute("href", `/chats/${referencedThreadId}`);
    const template = screen.getByLabelText("Message template Archived deck");
    const image = screen.getByLabelText("Preview reference.png");
    expect(template).toBeInTheDocument();
    expect(image).toBeInTheDocument();
    expect(
      template.compareDocumentPosition(structuredMessage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      image.compareDocumentPosition(structuredMessage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      structuredMessage.querySelector(
        'button[aria-label="Download original-report.pdf"]',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("File deleted-notes.txt")).toBeInTheDocument();
    expect(
      screen.queryByText("Legacy structured body should stay hidden"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Retired template")).not.toBeInTheDocument();
    expect(screen.queryByText("renamed-report.pdf")).not.toBeInTheDocument();

    const legacyBold = await screen.findByText("bold");
    expect(legacyBold.tagName).toBe("STRONG");
    expect(screen.getByText("Legacy", { exact: false })).toBeInTheDocument();
  });

  it("uses the legacy renderer when the feature switch is disabled", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000744";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured message disabled",
      chatMessages: [
        {
          id: "00000000-0000-4000-8000-000000000744",
          role: "user",
          content: "Legacy **fallback** stays",
          runId: "d0000000-0000-4000-a000-000000000744",
          structuredPrompt: {
            version: 1,
            parts: [{ type: "text", text: "Structured content stays hidden" }],
          },
          createdAt: "2026-07-21T10:02:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: false },
    });

    const legacyBold = await screen.findByText("fallback");
    expect(legacyBold.tagName).toBe("STRONG");
    expect(screen.getByText("Legacy", { exact: false })).toBeInTheDocument();
    expect(
      screen.queryByText("Structured content stays hidden"),
    ).not.toBeInTheDocument();
    expect(document.querySelector("[data-structured-user-message]")).toBeNull();
  });

  it("groups structured feedback and highlights chat thread mentions in notes", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000746";
    const referencedThreadId = "b0000000-0000-4000-a000-000000000747";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured feedback group",
      chatMessages: [
        {
          id: "00000000-0000-4000-8000-000000000746",
          role: "user",
          content: "Legacy feedback stays hidden",
          runId: "d0000000-0000-4000-a000-000000000746",
          structuredPrompt: {
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
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
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

  it("uses legacy feedback content when the feature switch is disabled", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000745";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured feedback rendering",
      chatMessages: [
        {
          id: "00000000-0000-4000-8000-000000000745",
          role: "user",
          content: "Flattened **feedback** stays visible",
          runId: "d0000000-0000-4000-a000-000000000745",
          structuredPrompt: {
            version: 1,
            parts: [
              {
                type: "feedback",
                quote: "Quoted reply passage",
                note: [{ type: "text", text: "Explain the complete result." }],
              },
            ],
          },
          createdAt: "2026-07-26T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: false },
    });

    const legacyFeedback = await screen.findByText("feedback");
    expect(legacyFeedback.tagName).toBe("STRONG");
    expect(screen.getByText("Flattened", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText("Quoted reply passage")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Explain the complete result."),
    ).not.toBeInTheDocument();
    expect(document.querySelector("[data-structured-user-message]")).toBeNull();
  });
});
