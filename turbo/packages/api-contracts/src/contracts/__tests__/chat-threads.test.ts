import { describe, expect, it } from "vitest";

import {
  artifactFavoriteBodySchema,
  artifactItemSchema,
  artifactsContract,
  artifactsListResponseSchema,
  chatMessagesContract,
  chatThreadMessagesContract,
  chatThreadModelSelectionContract,
  chatThreadsContract,
  generationTemplateRequestSchema,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  pagedChatMessageSchema,
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
    const parsed = pagedChatMessageSchema.safeParse({
      id: "message-1",
      role: "user",
      content: "Run the workflow",
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
    const parsed = pagedChatMessageSchema.safeParse({
      id: "message-1",
      role: "user",
      content: "Run the workflow",
      createdAt: "2026-07-13T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a canonical-only workflow Automation identifier", () => {
    const parsed = pagedChatMessageSchema.safeParse({
      id: "message-1",
      role: "user",
      content: "Run the workflow",
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
});

describe("chat message pagination request compatibility", () => {
  it("accepts current sequence cursors", () => {
    expect(
      chatThreadMessagesContract.list.query.safeParse({
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
      chatThreadMessagesContract.list.query.safeParse({
        beforeId,
        limit: "20",
      }),
    ).toMatchObject({
      success: true,
      data: { beforeId, limit: 20 },
    });
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

  it("normalizes legacy chat send modelSelection bodies to model", () => {
    const parsed = chatMessagesContract.send.body.safeParse({
      agentId: "agent-1",
      prompt: "Build a launch plan",
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

  it("normalizes legacy chat send bodies pinned to a concrete provider", () => {
    const parsed = chatMessagesContract.send.body.safeParse({
      agentId: "agent-1",
      prompt: "Build a launch plan",
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

describe("chat thread generation template contract", () => {
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
    expect(artifactsContract.listFavorites.method).toBe("GET");
    expect(artifactsContract.listFavorites.path).toBe(
      "/api/zero/artifacts/favorites",
    );
    expect(artifactsContract.favorite.method).toBe("POST");
    expect(artifactsContract.favorite.path).toBe(
      "/api/zero/artifacts/favorite",
    );
    expect(artifactsContract.unfavorite.method).toBe("POST");
    expect(artifactsContract.unfavorite.path).toBe(
      "/api/zero/artifacts/unfavorite",
    );
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

  it("accepts artifact favorite request bodies", () => {
    const parsed = artifactFavoriteBodySchema.safeParse({
      artifactUrl: "https://static.vm0.io/artifacts/launch-plan.html",
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
