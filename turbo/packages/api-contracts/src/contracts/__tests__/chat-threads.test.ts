import { describe, expect, it } from "vitest";

import {
  artifactsContract,
  chatThreadByIdContract,
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadComputerUseHostContract,
  chatThreadDraftSchema,
  chatThreadEventSchema,
  chatThreadModelSelectionContract,
  chatThreadsContract,
  chatEventSchema,
  generationTemplateRequestSchema,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  userMessageDocumentSchema,
  userMessageInputDocumentSchema,
} from "../chat-threads";

const legacyModelSelection = {
  modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
  selectedModel: "claude-sonnet-4-6",
};

const legacyProviderPinnedModelSelection = {
  modelProviderId: "11111111-1111-4111-8111-111111111111",
  selectedModel: "claude-sonnet-4-6",
};

describe("chat message response contract", () => {
  const workflowId = "11111111-1111-4111-8111-111111111111";

  it("rejects legacy automation metadata", () => {
    const parsed = chatEventSchema.safeParse({
      id: "message-1",
      threadId: "thread-1",
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Run the workflow" }],
      },
      seqId: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
      automationId: "legacy-automation-id",
      automationTitle: "Legacy automation",
      automationSnapshot: {
        id: "legacy-automation-id",
        title: "Legacy automation",
        description: null,
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects API messages without a sequence ID", () => {
    const parsed = chatEventSchema.safeParse({
      id: "message-1",
      threadId: "thread-1",
      eventType: "input.prompt",
      content: null,
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts workflow display metadata only as a user-message part", () => {
    const automationPart = {
      type: "automation" as const,
      workflowName: "scheduled-workflow",
      workflowId,
      automationBrief: "Daily schedule fired",
    };
    const parsed = chatEventSchema.safeParse({
      id: "message-1",
      threadId: "thread-1",
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [automationPart],
      },
      seqId: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.eventType !== "input.prompt") {
      return;
    }
    expect(parsed.data.userMessage.parts).toStrictEqual([automationPart]);
  });

  it("exposes user input documents as userMessage", () => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Run the task" }],
    };
    const event = chatEventSchema.safeParse({
      id: "message-1",
      threadId: "thread-1",
      eventType: "input.prompt",
      content: null,
      userMessage,
      seqId: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const send = chatEventsContract.send.body.safeParse({
      agentId: "agent-1",
      prompt: "Run the task",
      userMessage,
    });

    expect(event).toMatchObject({ success: true, data: { userMessage } });
    expect(send).toMatchObject({ success: true, data: { userMessage } });
  });

  it("rejects thread drafts that only carry the retired rich-input field", () => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Resume the draft" }],
    };

    expect(
      chatThreadDraftSchema.safeParse({
        draftStructuredPrompt: userMessage,
        draftAttachments: null,
      }).success,
    ).toBe(false);
  });

  it("accepts canonical thread draft responses", () => {
    const response = {
      draftUserMessage: {
        version: 1 as const,
        parts: [{ type: "text" as const, text: "Resume the draft" }],
      },
      draftAttachments: null,
    };

    expect(chatThreadDraftSchema.parse(response)).toStrictEqual(response);
  });

  it("requires userMessage for non-empty thread drafts", () => {
    expect(
      chatThreadByIdContract.patch.body.safeParse({
        draftUserMessage: null,
        draftAttachments: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      chatThreadByIdContract.patch.body.safeParse({
        draftUserMessage: null,
        draftAttachments: [
          {
            id: "draft-file",
            filename: "brief.md",
            contentType: "text/markdown",
            size: 42,
            url: "https://example.com/brief.md",
          },
        ],
      }),
    ).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            path: ["draftUserMessage"],
          }),
        ],
      },
    });
  });
});

describe("chat event pagination request compatibility", () => {
  it("accepts current sequence cursors", () => {
    expect(
      chatThreadEventsContract.list.query.safeParse({
        sinceSeqId: "42",
        limit: "20",
      }),
    ).toMatchObject({
      success: true,
      data: { sinceSeqId: 42, limit: 20 },
    });
  });

  it("accepts previous frontend UUID cursors during rollout", () => {
    const beforeId = "11111111-1111-4111-8111-111111111111";
    expect(
      chatThreadEventsContract.list.query.safeParse({
        beforeId,
        limit: "20",
      }),
    ).toMatchObject({
      success: true,
      data: { beforeId, limit: 20 },
    });
  });
});

describe("chat thread event sequence contract", () => {
  it("coerces current sequence cursors", () => {
    expect(
      chatThreadsContract.events.query.safeParse({ sinceSeqId: "42" }),
    ).toMatchObject({
      success: true,
      data: { sinceSeqId: 42 },
    });
  });

  it("accepts previous API responses during independent app promotion", () => {
    const legacyEvent = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "renamed",
      chatThreadId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      title: "Legacy cursor title",
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
      createdAt: "2026-07-28T00:00:00.000Z",
    };

    expect(
      chatThreadsContract.snapshot.responses[200].safeParse({
        chatThreads: [],
        latestEventId: legacyEvent.id,
      }).success,
    ).toBe(true);
    expect(
      chatThreadsContract.events.responses[200].safeParse({
        events: [legacyEvent],
        hasMore: false,
      }).success,
    ).toBe(true);
    expect(chatThreadEventSchema.safeParse(legacyEvent).success).toBe(false);
  });
});

describe("chat thread model request compatibility", () => {
  it("normalizes legacy thread create modelSelection bodies to model", () => {
    const parsed = chatThreadsContract.create.body.safeParse({
      agentId: "agent-1",
      modelSelection: legacyModelSelection,
      title: "Launch plan",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toMatchObject({
      agentId: "agent-1",
      model: "claude-sonnet-4-6",
      title: "Launch plan",
    });
    expect(parsed.data).not.toHaveProperty("modelSelection");
  });

  it("normalizes legacy thread model update bodies to model", () => {
    const parsed = chatThreadModelSelectionContract.update.body.safeParse({
      modelSelection: legacyModelSelection,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toStrictEqual({ model: "claude-sonnet-4-6" });
  });

  it("normalizes legacy thread model clears to model null", () => {
    const parsed = chatThreadModelSelectionContract.update.body.safeParse({
      modelSelection: null,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toStrictEqual({ model: null });
  });

  it("normalizes legacy chat event send modelSelection bodies to model", () => {
    const parsed = chatEventsContract.send.body.safeParse({
      agentId: "agent-1",
      prompt: "Build a launch plan",
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Build a launch plan" }],
      },
      modelProvider: "anthropic-api-key",
      modelSelection: legacyModelSelection,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toMatchObject({
      agentId: "agent-1",
      prompt: "Build a launch plan",
      model: "claude-sonnet-4-6",
    });
    expect(parsed.data).not.toHaveProperty("modelProvider");
    expect(parsed.data).not.toHaveProperty("modelSelection");
  });

  it("normalizes legacy thread create bodies pinned to a concrete provider", () => {
    const parsed = chatThreadsContract.create.body.safeParse({
      agentId: "agent-1",
      modelSelection: legacyProviderPinnedModelSelection,
      title: "Launch plan",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toMatchObject({
      agentId: "agent-1",
      model: "claude-sonnet-4-6",
      title: "Launch plan",
    });
    expect(parsed.data).not.toHaveProperty("modelSelection");
  });

  it("normalizes legacy thread model updates pinned to a concrete provider", () => {
    const parsed = chatThreadModelSelectionContract.update.body.safeParse({
      modelSelection: legacyProviderPinnedModelSelection,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toStrictEqual({ model: "claude-sonnet-4-6" });
  });

  it("normalizes legacy chat event send bodies pinned to a concrete provider", () => {
    const parsed = chatEventsContract.send.body.safeParse({
      agentId: "agent-1",
      prompt: "Build a launch plan",
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Build a launch plan" }],
      },
      modelProvider: "anthropic-api-key",
      modelSelection: legacyProviderPinnedModelSelection,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).toMatchObject({
      agentId: "agent-1",
      prompt: "Build a launch plan",
      model: "claude-sonnet-4-6",
    });
    expect(parsed.data).not.toHaveProperty("modelProvider");
    expect(parsed.data).not.toHaveProperty("modelSelection");
  });
});

describe("chat thread computer access contract", () => {
  const hostId = "11111111-1111-4111-8111-111111111111";

  it("accepts Cloud browser as an explicit thread selection", () => {
    expect(
      chatThreadComputerUseHostContract.update.body.safeParse({
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      }),
    ).toMatchObject({ success: true });
  });

  it("rejects selecting Cloud browser and Computer Use together", () => {
    expect(
      chatEventsContract.send.body.safeParse({
        agentId: "agent-1",
        prompt: "Browse from both places",
        computerUseHostId: hostId,
        cloudBrowserEnabled: true,
      }),
    ).toMatchObject({ success: false });
    expect(
      chatThreadComputerUseHostContract.update.body.safeParse({
        computerUseHostId: hostId,
        cloudBrowserEnabled: true,
      }),
    ).toMatchObject({ success: false });
  });
});

describe("chat thread generation template contract", () => {
  it("allows at most one non-content user-message part", () => {
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "source", kind: "slack" },
          {
            type: "automation",
            workflowName: "daily-digest",
          },
        ],
      }),
    ).toMatchObject({ success: false });
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "text", text: "Visible content" },
          { type: "goal", goalBrief: "Finish the rollout" },
        ],
      }),
    ).toMatchObject({ success: true });
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "goal", goalBrief: "Finish the rollout" },
          { type: "morning_brief", briefDate: "2026-08-05" },
        ],
      }),
    ).toMatchObject({ success: false });
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "text", text: "Generate my Morning Brief" },
          { type: "morning_brief", briefDate: "2026-08-05" },
        ],
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts an internal agent-run source annotation", () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const threadId = "00000000-0000-4000-8000-000000000002";
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          { type: "text", text: "Delegated prompt" },
          {
            type: "source",
            kind: "agent",
            runId,
            threadId,
            agentId: "00000000-0000-4000-8000-000000000003",
            titleSnapshot: "New thread",
            href: `/chats/${threadId}#run-${runId}`,
          },
        ],
      }),
    ).toMatchObject({ success: true });
  });

  it("accepts one server-owned model annotation but rejects it upstream", () => {
    const userMessage = {
      version: 1,
      parts: [
        { type: "text", text: "Run with this model" },
        { type: "model", selectedModel: "claude-sonnet-4-6" },
      ],
    };
    expect(userMessageDocumentSchema.safeParse(userMessage)).toMatchObject({
      success: true,
    });
    expect(
      userMessageDocumentSchema.safeParse({
        version: 1,
        parts: [
          ...userMessage.parts,
          { type: "model", selectedModel: "gpt-5.6-sol" },
        ],
      }),
    ).toMatchObject({ success: false });
    expect(userMessageInputDocumentSchema.safeParse(userMessage)).toMatchObject(
      { success: false },
    );
  });

  it("accepts template parts inside feedback notes", () => {
    const parsed = userMessageDocumentSchema.safeParse({
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "Original reply",
          note: [
            { type: "text", text: "Use " },
            {
              type: "template",
              titleSnapshot: "Paper cut",
              template: {
                type: "illustration",
                selection: { illustrationStyleId: "paper-cut" },
              },
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts presentation template selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "presentation",
      selection: {
        templateId: "template:html-ppt-playful-launch",
        colorSystemId: "color-system:carnival",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects presentation selections with design-system ids", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "presentation",
      selection: {
        designSystemId: "design-system:playful-editorial",
        templateId: "template:html-ppt-playful-launch",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts workflow template selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "workflow",
      selection: {
        workflowTemplateId: "workflow-template:auto-inbox-label",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts avatar snapshots in the compatible video template envelope", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "video",
      selection: {
        stylePresetId: "avatar-template:81",
        titleSnapshot: "Ada",
        previewUrl: "https://example.com/ada.jpg",
        voiceId: "en-US-ChristopherNeural",
        aspectRatio: "landscape",
      },
    });

    expect(parsed).toMatchObject({
      success: true,
      data: {
        type: "video",
        selection: {
          stylePresetId: "avatar-template:81",
          titleSnapshot: "Ada",
          previewUrl: "https://example.com/ada.jpg",
          voiceId: "en-US-ChristopherNeural",
          aspectRatio: "landscape",
        },
      },
    });
  });

  it("rejects empty workflow template ids", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "workflow",
      selection: { workflowTemplateId: "" },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts website template selections", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "website",
      selection: {
        websiteTemplateId: "website-template:warm-cards",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects empty website template ids", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "website",
      selection: { websiteTemplateId: "" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects extra website selection fields", () => {
    const parsed = generationTemplateRequestSchema.safeParse({
      type: "website",
      selection: {
        templateId: "template:warm-cards",
        websiteTemplateId: "website-template:warm-cards",
      },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("artifacts contract", () => {
  it("exposes image edit snapshot compatibility routes", () => {
    expect(artifactsContract.getImageEditSnapshot.method).toBe("GET");
    expect(artifactsContract.getImageEditSnapshot.path).toBe(
      "/api/zero/artifacts/image-edit-snapshot",
    );
    expect(artifactsContract.upsertImageEditSnapshot.method).toBe("PUT");
    expect(artifactsContract.upsertImageEditSnapshot.path).toBe(
      "/api/zero/artifacts/image-edit-snapshot",
    );
    expect(artifactsContract.deleteImageEditSnapshot.method).toBe("DELETE");
    expect(artifactsContract.deleteImageEditSnapshot.path).toBe(
      "/api/zero/artifacts/image-edit-snapshot",
    );
  });
});
