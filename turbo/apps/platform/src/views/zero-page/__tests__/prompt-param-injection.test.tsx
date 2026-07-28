import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
} from "@vm0/core";
import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";
import type { OrgModelPolicy } from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { searchParams$ } from "../../../signals/route.ts";
import { talkDraft$ } from "../../../signals/zero-page/chat-draft.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

function modelPolicy(
  model: OrgModelPolicy["model"],
  modelLabel: string,
): OrgModelPolicy {
  return {
    id: crypto.randomUUID(),
    model,
    modelLabel,
    isDefault: true,
    defaultProviderType: "vm0",
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}

describe("prompt query parameter injection", () => {
  it("prefills the chat draft from the app root prompt URL", async () => {
    detachedSetupPage({
      context,
      path: "/?prompt=Start%20my%20first%20task",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(textarea).toHaveTextContent("Start my first task");
  });

  it("starts a chat draft from a prompt URL", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat?prompt=Set%20up%20a%20daily%20report",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(textarea).toHaveTextContent("Set up a daily report");
  });

  it("starts an optimistic chat from the prompt route", async () => {
    let runPrompt: string | undefined;
    let userMessage: unknown;
    let createdThreadModel: string | null | undefined;
    context.mocks.data.orgModelPolicies([
      modelPolicy("deepseek-v4-pro", "DeepSeek V4 Pro"),
    ]);
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        userMessage = body.userMessage;
      },
      onThreadCreate: (body) => {
        createdThreadModel = body.modelSelection.selectedModel;
      },
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Build%20a%20launch%20recap&connector=slack&model=deepseek-v4-pro",
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Build a launch recap")).toBeInTheDocument();
      expect(runPrompt).toBe("Build a launch recap");
      expect(userMessage).toStrictEqual({
        version: 1,
        parts: [{ type: "text", text: "Build a launch recap" }],
      });
      expect(createdThreadModel).toBe("deepseek-v4-pro");
    });
  });

  it("keeps prompt route state when the requested model is unavailable", async () => {
    let threadCreateCount = 0;
    let runCreateCount = 0;
    context.mocks.data.orgModelPolicies([]);
    mockChatLifecycle(context, {
      onThreadCreate: () => {
        threadCreateCount++;
      },
      onRunCreate: () => {
        runCreateCount++;
      },
    });
    const draft = context.store.get(talkDraft$);
    act(() => {
      context.store.set(draft.setInput$, "Existing draft");
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Keep%20this%20prompt&connector=slack&model=gpt-5.5",
    });

    await expect(
      screen.findByText("The selected model is not available"),
    ).resolves.toBeInTheDocument();
    expect(threadCreateCount).toBe(0);
    expect(runCreateCount).toBe(0);
    expect(pathname()).toBe("/prompt");
    expect(context.store.get(searchParams$).get("prompt")).toBe(
      "Keep this prompt",
    );
    expect(context.store.get(searchParams$).get("model")).toBe("gpt-5.5");
    expect(context.store.get(draft.input$)).toBe("Existing draft");
  });

  it("starts an optimistic video template chat from the prompt route", async () => {
    const videoTemplate = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.id === "video-template:luxury-product";
    });
    expect(videoTemplate).toBeDefined();

    let runPrompt: string | undefined;
    let stylePresetId: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        stylePresetId =
          body.generationTemplate?.type === "video"
            ? body.generationTemplate.selection.stylePresetId
            : undefined;
      },
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Make%20a%20product%20spot&template=video-template%3Aluxury-product",
    });

    await waitFor(() => {
      expect(screen.getByText("Make a product spot")).toBeInTheDocument();
      expect(runPrompt).toBe("Make a product spot");
      expect(stylePresetId).toBe(videoTemplate?.id);
    });
  });

  it("starts an optimistic presentation template chat from the prompt route", async () => {
    const presentationTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS.find(
      (item) => {
        return item.slug === "playful-launch-presentation";
      },
    );
    expect(presentationTemplate).toBeDefined();

    let runPrompt: string | undefined;
    let userMessage: UserMessageDocument | undefined;
    let selection:
      | {
          templateId: string;
          colorSystemId?: string;
          previewUrl?: string;
        }
      | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        userMessage = body.userMessage;
        selection =
          body.generationTemplate?.type === "presentation"
            ? body.generationTemplate.selection
            : undefined;
      },
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Make%20a%20launch%20deck&template=presentation-template%3Aplayful-launch-presentation",
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Make a launch deck")).toBeInTheDocument();
      expect(runPrompt).toBe("Make a launch deck");
      expect(selection).toMatchObject({
        colorSystemId: presentationTemplate?.colorSystemId,
        templateId: presentationTemplate?.templateId,
        previewUrl: presentationTemplate?.embedUrl,
      });
      expect(userMessage).toStrictEqual({
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: presentationTemplate?.title,
            template: {
              type: "presentation",
              selection,
            },
          },
          { type: "text", text: "Make a launch deck" },
        ],
      });
    });
  });

  it("starts an optimistic illustration template chat from the prompt route", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.slug === "sunlit-gouache";
    });
    expect(illustrationTemplate).toBeDefined();

    let runPrompt: string | undefined;
    let illustrationStyleId: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        illustrationStyleId =
          body.generationTemplate?.type === "illustration"
            ? body.generationTemplate.selection.illustrationStyleId
            : undefined;
      },
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Make%20a%20library%20scene&template=illustration-template%3Asunlit-gouache",
    });

    await waitFor(() => {
      expect(screen.getByText("Make a library scene")).toBeInTheDocument();
      expect(runPrompt).toBe("Make a library scene");
      expect(illustrationStyleId).toBe(
        illustrationTemplate?.illustrationStyleId,
      );
    });
  });

  it("starts an optimistic website template chat from the prompt route", async () => {
    const websiteTemplate = WEBSITE_TEMPLATE_ITEMS.find((item) => {
      return item.id === "website-template:warm-cards";
    });
    expect(websiteTemplate).toBeDefined();

    let runPrompt: string | undefined;
    let websiteTemplateId: string | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        websiteTemplateId =
          body.generationTemplate?.type === "website"
            ? body.generationTemplate.selection.websiteTemplateId
            : undefined;
      },
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Make%20a%20warm%20website&template=website-template%3Awarm-cards",
    });

    await waitFor(() => {
      expect(screen.getByText("Make a warm website")).toBeInTheDocument();
      expect(runPrompt).toBe("Make a warm website");
      expect(websiteTemplateId).toBe(websiteTemplate?.id);
    });
  });
});
