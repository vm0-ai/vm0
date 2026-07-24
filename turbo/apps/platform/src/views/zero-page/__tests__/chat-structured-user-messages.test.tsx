import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

describe("structured user messages", () => {
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

  it("renders structured feedback quotes as blockquotes without the structured prompt rollout", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000745";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Structured feedback rendering",
      chatMessages: [
        {
          id: "00000000-0000-4000-8000-000000000745",
          role: "user",
          content: "Flattened feedback stays hidden",
          runId: "d0000000-0000-4000-a000-000000000745",
          structuredPrompt: {
            version: 1,
            parts: [
              {
                type: "feedback",
                quote: "Quoted reply passage",
                note: "Explain the complete result.",
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

    const quote = await screen.findByText("Quoted reply passage");
    expect(quote.tagName).toBe("BLOCKQUOTE");
    expect(quote).toHaveAttribute("data-structured-feedback-quote");
    expect(quote).toHaveClass(
      "border-l-2",
      "border-border",
      "pl-3",
      "text-muted-foreground",
    );
    expect(
      screen.getByText("Explain the complete result."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("> Quoted reply passage"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Flattened feedback stays hidden")).toBeNull();
  });
});
