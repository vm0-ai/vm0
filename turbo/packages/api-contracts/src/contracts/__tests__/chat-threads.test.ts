import { describe, expect, it } from "vitest";

import {
  artifactItemSchema,
  artifactsContract,
  artifactsListResponseSchema,
  chatMessagesContract,
  chatThreadModelSelectionContract,
  chatThreadsContract,
  generationTemplateRequestSchema,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "../chat-threads";

const legacyModelSelection = {
  modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
  selectedModel: "claude-sonnet-4-6",
};

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
  it("exposes an org-level bulk generated artifacts route", () => {
    expect(artifactsContract.list.method).toBe("GET");
    expect(artifactsContract.list.path).toBe("/api/zero/artifacts");
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
    });

    expect(parsed.success).toBe(true);
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
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a bulk list response", () => {
    const parsed = artifactsListResponseSchema.safeParse({
      artifacts: [],
      truncated: false,
    });

    expect(parsed.success).toBe(true);
  });
});
