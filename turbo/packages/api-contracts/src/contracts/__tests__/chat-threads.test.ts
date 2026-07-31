import { describe, expect, it } from "vitest";

import {
  artifactItemSchema,
  artifactsContract,
  artifactsListResponseSchema,
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
  const automationId = "11111111-1111-4111-8111-111111111111";
  const workflowSnapshot = {
    name: "scheduled-workflow",
    displayName: "Scheduled workflow",
    description: null,
  };

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

  it("accepts a canonical-only workflow Automation identifier", () => {
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
      workflowSnapshot: { ...workflowSnapshot, automationId },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.workflowSnapshot).toStrictEqual({
      ...workflowSnapshot,
      automationId,
    });
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
  it("exposes an org-level generated artifacts route", () => {
    expect(artifactsContract.list.method).toBe("GET");
    expect(artifactsContract.list.path).toBe("/api/zero/artifacts");
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

  it("accepts keyset pagination query params", () => {
    const parsed = artifactsContract.list.query.safeParse({
      limit: "50",
      cursor: "opaque-token",
      updatedAfter: "2026-07-20T04:00:00.000Z",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.limit).toBe(50);
    expect(parsed.success && parsed.data.updatedAfter).toBe(
      "2026-07-20T04:00:00.000Z",
    );
  });

  it("accepts a minimal generated artifact item", () => {
    const parsed = artifactItemSchema.safeParse({
      artifactItemId: "run-1:file-1",
      threadId: "thread-1",
      runId: "run-1",
      fileId: "file-1",
      agentId: "agent-1",
      filename: "launch-plan.html",
      contentType: "text/html",
      url: "https://static.vm0.io/artifacts/launch-plan.html",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.size).toBe(0);
  });

  it("accepts artifact metadata used by filters and Drive sync UI", () => {
    const parsed = artifactItemSchema.safeParse({
      artifactItemId: "run-1:file-1",
      threadId: "thread-1",
      runId: "run-1",
      fileId: "file-1",
      agentId: "agent-1",
      agentName: "Website Builder",
      agentAvatarUrl: null,
      threadTitle: "Launch site",
      filename: "launch-plan.html",
      contentType: "text/html",
      url: "https://static.vm0.io/artifacts/launch-plan.html",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
      artifactKind: "hosted-site",
      googleDriveSync: {
        status: "synced",
        id: "drive-file-1",
        name: "launch-plan.html",
        webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("requires source context for chat navigation and agent filtering", () => {
    const parsed = artifactItemSchema.safeParse({
      artifactItemId: "run-1:file-1",
      runId: "run-1",
      fileId: "file-1",
      filename: "launch-plan.html",
      contentType: "text/html",
      url: "https://static.vm0.io/artifacts/launch-plan.html",
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a keyset-paginated list response", () => {
    const parsed = artifactsListResponseSchema.safeParse({
      artifacts: [],
      truncated: false,
      nextCursor: null,
      syncUntil: "2026-07-20T04:01:00.000Z",
    });

    expect(parsed.success).toBe(true);
  });

  it("requires nextCursor on the list response", () => {
    const parsed = artifactsListResponseSchema.safeParse({
      artifacts: [],
      truncated: false,
    });

    expect(parsed.success).toBe(false);
  });
});
