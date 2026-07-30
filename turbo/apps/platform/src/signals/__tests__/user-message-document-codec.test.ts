import type { JSONContent } from "@tiptap/core";
import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { testContext } from "./test-helpers.ts";
import { createDraftSignals } from "../zero-page/chat-draft.ts";
import { createWorkflowComposerSignals } from "../zero-page/tiptap-workflow-composer.ts";
import {
  editorDocToMessageDocument,
  messageDocumentToDisplayText,
  messageDocumentToEditorDoc,
  messageDocumentToPrompt,
} from "../zero-page/user-message-document-codec.ts";

const context = testContext();
const THREAD_ID = "1fe7f3cc-40b9-49f2-8f86-5f07d8d8dfd8";
const MENTIONED_AGENT_ID = "a1000000-0000-4000-a000-000000000001";

function presentationTemplate(): GenerationTemplateRequest {
  return {
    type: "presentation",
    selection: {
      templateId: "pitch-deck",
      colorSystemId: "color-system:modern-blue",
      previewUrl: "https://example.com/pitch-deck.png",
    },
  };
}

function persistedAttachments(): readonly PersistedAttachment[] {
  return [
    {
      id: "file-one",
      url: "https://example.com/file-one.pdf",
      filename: "file-one.pdf",
      contentType: "application/pdf",
      size: 100,
    },
    {
      id: "file-two",
      url: "https://example.com/file-two.txt",
      filename: "file-two.txt",
      contentType: "text/plain",
      size: 20,
    },
  ];
}

function workflowComposerDocument(content: JSONContent) {
  const composer = createWorkflowComposerSignals(createDraftSignals());
  context.signal.addEventListener("abort", () => {
    composer.editor.destroy();
  });
  return composer.editor.schema.nodeFromJSON(content);
}

describe("user message document codec", () => {
  it("round-trips the supported composer nodes through the business document", () => {
    const editorDocument = workflowComposerDocument({
      type: "doc",
      content: [
        {
          type: "templateAttachment",
          attrs: {
            templateType: "presentation",
            title: "Pitch deck",
            category: "slides",
            previewImageUrl: "https://example.com/pitch-deck.png",
          },
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "  Review " },
            {
              type: "chatThreadMention",
              attrs: { threadId: THREAD_ID, title: "Project Alpha" },
            },
            { type: "text", text: " with " },
            {
              type: "agentMention",
              attrs: { agentId: MENTIONED_AGENT_ID, name: "Ada" },
            },
            { type: "text", text: " then" },
            { type: "hardBreak" },
            { type: "text", text: "continue  " },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "last" }],
        },
      ],
    });

    const template = presentationTemplate();
    const attachments = persistedAttachments();
    const structured = editorDocToMessageDocument(editorDocument, {
      generationTemplate: template,
      attachments,
    });
    expect(structured).toStrictEqual({
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: "Pitch deck",
          template,
        },
        {
          type: "file",
          fileId: "file-one",
          filenameSnapshot: "file-one.pdf",
          contentType: "application/pdf",
        },
        {
          type: "file",
          fileId: "file-two",
          filenameSnapshot: "file-two.txt",
          contentType: "text/plain",
        },
        { type: "text", text: "  Review " },
        {
          type: "chat_thread",
          threadId: THREAD_ID,
          titleSnapshot: "Project Alpha",
        },
        { type: "text", text: " with " },
        {
          type: "agent",
          agentId: MENTIONED_AGENT_ID,
          nameSnapshot: "Ada",
        },
        { type: "text", text: " then\ncontinue  \nlast" },
      ],
    });
    expect(messageDocumentToPrompt(structured)).toBe(
      `  Review [Project Alpha](/chats/${THREAD_ID}) with ` +
        `[Ada](/agents/${MENTIONED_AGENT_ID}/chat) then\ncontinue  \nlast`,
    );

    const restored = messageDocumentToEditorDoc(structured);
    expect(restored).toStrictEqual({
      type: "doc",
      content: [
        {
          type: "templateAttachment",
          attrs: {
            templateType: "presentation",
            title: "Pitch deck",
            category: "slides",
            previewImageUrl: "https://example.com/pitch-deck.png",
          },
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "  Review " },
            {
              type: "chatThreadMention",
              attrs: { threadId: THREAD_ID, title: "Project Alpha" },
            },
            { type: "text", text: " with " },
            {
              type: "agentMention",
              attrs: {
                agentId: MENTIONED_AGENT_ID,
                name: "Ada",
                avatarUrl: null,
              },
            },
            { type: "text", text: " then" },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "continue  " }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "last" }],
        },
      ],
    });
    if (!restored) {
      throw new Error("Expected the structured document to restore");
    }

    expect(
      editorDocToMessageDocument(workflowComposerDocument(restored), {
        generationTemplate: template,
        attachments,
      }),
    ).toStrictEqual(structured);
  });

  it("preserves multiple inline templates and templates inside feedback notes", () => {
    const presentation = presentationTemplate();
    const illustration = {
      type: "illustration",
      selection: { illustrationStyleId: "paper-cut" },
    } satisfies GenerationTemplateRequest;
    const editorDocument = workflowComposerDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            {
              type: "inlineTemplate",
              attrs: {
                templateType: "presentation",
                template: presentation,
                title: "Pitch deck",
                category: "slides",
                previewImageUrl: "https://example.com/pitch-deck.png",
              },
            },
            { type: "text", text: " for dogs and " },
            {
              type: "inlineTemplate",
              attrs: {
                templateType: "illustration",
                template: illustration,
                title: "Paper cut",
                category: "illustration",
                previewImageUrl: null,
              },
            },
            { type: "text", text: " for cats" },
          ],
        },
        {
          type: "feedbackItem",
          attrs: {
            feedbackId: 1,
            quote: "Original reply",
            showDivider: false,
            fill: true,
          },
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Restyle with " },
                {
                  type: "inlineTemplate",
                  attrs: {
                    templateType: "illustration",
                    template: illustration,
                    title: "Paper cut",
                    category: "illustration",
                    previewImageUrl: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const structured = editorDocToMessageDocument(editorDocument);
    expect(structured).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: "Use " },
        {
          type: "template",
          titleSnapshot: "Pitch deck",
          template: presentation,
        },
        { type: "text", text: " for dogs and " },
        {
          type: "template",
          titleSnapshot: "Paper cut",
          template: illustration,
        },
        { type: "text", text: " for cats" },
        {
          type: "feedback",
          quote: "Original reply",
          note: [
            { type: "text", text: "Restyle with " },
            {
              type: "template",
              titleSnapshot: "Paper cut",
              template: illustration,
            },
          ],
        },
      ],
    });

    const restored = messageDocumentToEditorDoc(structured, {
      inlineTemplates: true,
    });
    expect(restored).not.toBeNull();
    if (!restored) {
      throw new Error("Expected inline templates to restore");
    }
    expect(
      editorDocToMessageDocument(workflowComposerDocument(restored)),
    ).toStrictEqual(structured);
    expect(
      messageDocumentToDisplayText(structured, { inlineTemplates: true }),
    ).toContain(
      "Use [Template: Pitch deck] for dogs and [Template: Paper cut] for cats",
    );
    expect(
      messageDocumentToPrompt(structured, { inlineTemplates: true }),
    ).toContain("Restyle with Select Paper cut illustration template");
  });

  it("serializes an inline template-only message without ambient template state", () => {
    const template = presentationTemplate();
    const structured = editorDocToMessageDocument(
      workflowComposerDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "inlineTemplate",
                attrs: {
                  templateType: "presentation",
                  template,
                  title: "Pitch deck",
                  category: "slides",
                  previewImageUrl: null,
                },
              },
            ],
          },
        ],
      }),
    );

    expect(structured).toStrictEqual({
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: "Pitch deck",
          template,
        },
      ],
    });
  });

  it("normalizes paragraph boundaries and hard breaks without trimming", () => {
    const editorDocument = workflowComposerDocument({
      type: "doc",
      content: [
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [
            { type: "text", text: " a" },
            { type: "hardBreak" },
            { type: "text", text: "b " },
          ],
        },
        { type: "paragraph" },
      ],
    });

    const structured = editorDocToMessageDocument(editorDocument);
    expect(structured).toStrictEqual({
      version: 1,
      parts: [{ type: "text", text: "\n a\nb \n" }],
    });
    expect(messageDocumentToEditorDoc(structured)).toStrictEqual({
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: " a" }] },
        { type: "paragraph", content: [{ type: "text", text: "b " }] },
        { type: "paragraph" },
      ],
    });
  });

  it("keeps file-only messages in external attachment state", () => {
    const structured = editorDocToMessageDocument(
      workflowComposerDocument({
        type: "doc",
        content: [{ type: "paragraph" }],
      }),
      { attachments: persistedAttachments().slice(0, 1) },
    );

    expect(structured).toStrictEqual({
      version: 1,
      parts: [
        {
          type: "file",
          fileId: "file-one",
          filenameSnapshot: "file-one.pdf",
          contentType: "application/pdf",
        },
      ],
    });
    expect(messageDocumentToEditorDoc(structured)).toStrictEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(messageDocumentToPrompt(structured)).toBe("");
  });

  it("serializes feedback cards with their surrounding prompt sections", () => {
    const editorDocument = workflowComposerDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Before" }],
        },
        {
          type: "feedbackItem",
          attrs: {
            feedbackId: 1,
            quote: "First quote",
            showDivider: false,
            fill: false,
          },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "First note" }],
            },
          ],
        },
        {
          type: "feedbackItem",
          attrs: {
            feedbackId: 2,
            quote: "Second quote",
            showDivider: true,
            fill: true,
          },
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Second note" },
                { type: "hardBreak" },
                {
                  type: "chatThreadMention",
                  attrs: { threadId: THREAD_ID, title: "Project Alpha" },
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "After" }],
        },
      ],
    });

    const structured = editorDocToMessageDocument(editorDocument);
    expect(structured).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: "Before" },
        {
          type: "feedback",
          quote: "First quote",
          note: [{ type: "text", text: "First note" }],
        },
        {
          type: "feedback",
          quote: "Second quote",
          note: [
            { type: "text", text: "Second note\n" },
            {
              type: "chat_thread",
              threadId: THREAD_ID,
              titleSnapshot: "Project Alpha",
            },
          ],
        },
        { type: "text", text: "After" },
      ],
    });
    const expectedPrompt =
      "Before\n\nFeedback on 2 parts of your reply:\n\n" +
      "> First quote\n\nFirst note\n\n---\n\n" +
      `> Second quote\n\nSecond note\n[Project Alpha](/chats/${THREAD_ID})\n\nAfter`;
    expect(messageDocumentToPrompt(structured)).toBe(expectedPrompt);
    expect(messageDocumentToDisplayText(structured)).toBe(expectedPrompt);

    const restored = messageDocumentToEditorDoc(structured);
    expect(restored).toStrictEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Before" }],
        },
        {
          type: "feedbackItem",
          attrs: {
            feedbackId: 1,
            quote: "First quote",
            showDivider: false,
            fill: false,
          },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "First note" }],
            },
          ],
        },
        {
          type: "feedbackItem",
          attrs: {
            feedbackId: 2,
            quote: "Second quote",
            showDivider: true,
            fill: true,
          },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Second note" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "chatThreadMention",
                  attrs: { threadId: THREAD_ID, title: "Project Alpha" },
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "After" }],
        },
      ],
    });
    if (!restored) {
      throw new Error("Expected feedback document to restore");
    }
    expect(
      editorDocToMessageDocument(workflowComposerDocument(restored)),
    ).toStrictEqual(structured);
  });

  it("preserves mail source metadata for structured feedback", () => {
    const structured: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "Mail body",
          note: [{ type: "text", text: "Rewrite this paragraph" }],
          source: {
            type: "mail",
            id: "mail-draft-id",
            status: "sent",
            sentId: "sent-message-id",
          },
        },
      ],
    };
    const expectedPrompt =
      "Feedback on this part of a sent email " +
      "(mail ID: mail-draft-id, sent ID: sent-message-id):\n\n" +
      "> Mail body\n\nRewrite this paragraph";

    expect(messageDocumentToPrompt(structured)).toBe(expectedPrompt);
    expect(messageDocumentToDisplayText(structured)).toBe(expectedPrompt);

    const restored = messageDocumentToEditorDoc(structured);
    expect(restored).toStrictEqual({
      type: "doc",
      content: [
        {
          type: "feedbackItem",
          attrs: {
            feedbackId: 1,
            quote: "Mail body",
            showDivider: false,
            fill: true,
            sourceType: "mail",
            sourceId: "mail-draft-id",
            sourceStatus: "sent",
            sourceSentId: "sent-message-id",
          },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Rewrite this paragraph" }],
            },
          ],
        },
      ],
    });
    if (!restored) {
      throw new Error("Expected feedback document to restore");
    }
    expect(
      editorDocToMessageDocument(workflowComposerDocument(restored)),
    ).toStrictEqual(structured);
  });

  it("returns null for malformed or unsupported documents", () => {
    const unsupportedEditorDocument = workflowComposerDocument({
      type: "doc",
      content: [
        {
          type: "feedbackItem",
          attrs: {
            feedbackId: 1,
            quote: 123,
            showDivider: false,
            fill: false,
          },
          content: [{ type: "paragraph" }],
        },
      ],
    });
    expect(editorDocToMessageDocument(unsupportedEditorDocument)).toBeNull();

    const templateDocument = workflowComposerDocument({
      type: "doc",
      content: [
        {
          type: "templateAttachment",
          attrs: {
            templateType: "presentation",
            title: "Pitch deck",
            category: "slides",
            previewImageUrl: null,
          },
        },
      ],
    });
    expect(editorDocToMessageDocument(templateDocument)).toBeNull();
    expect(
      editorDocToMessageDocument(
        workflowComposerDocument({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "x" }] },
          ],
        }),
        { generationTemplate: presentationTemplate() },
      ),
    ).toBeNull();

    const malformed = { version: 1, parts: [] };
    expect(messageDocumentToEditorDoc(malformed)).toBeNull();
    expect(messageDocumentToPrompt(malformed)).toBeNull();
  });

  it("restores each template variant to the shared attachment node", () => {
    const templates: readonly UserMessageDocument[] = [
      {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: "Illustration style",
            template: {
              type: "illustration",
              selection: { illustrationStyleId: "paper-cut" },
            },
          },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: "Video style",
            template: {
              type: "video",
              selection: { stylePresetId: "cinematic" },
            },
          },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: "Workflow template",
            template: {
              type: "workflow",
              selection: { workflowTemplateId: "weekly-report" },
            },
          },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: "Website template",
            template: {
              type: "website",
              selection: { websiteTemplateId: "launch-page" },
            },
          },
        ],
      },
    ];

    expect(
      templates.map((document) => {
        return messageDocumentToEditorDoc(document)?.content?.[0];
      }),
    ).toStrictEqual([
      {
        type: "templateAttachment",
        attrs: {
          templateType: "illustration",
          title: "Illustration style",
          category: "illustration",
          previewImageUrl: null,
        },
      },
      {
        type: "templateAttachment",
        attrs: {
          templateType: "video",
          title: "Video style",
          category: "video",
          previewImageUrl: null,
        },
      },
      {
        type: "templateAttachment",
        attrs: {
          templateType: "workflow",
          title: "Workflow template",
          category: "workflow",
          previewImageUrl: null,
        },
      },
      {
        type: "templateAttachment",
        attrs: {
          templateType: "website",
          title: "Website template",
          category: "website",
          previewImageUrl: null,
        },
      },
    ]);
  });
});
