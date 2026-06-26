import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
} from "@vm0/core";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

describe("prompt query parameter injection", () => {
  it("prefills the chat draft from the app root prompt URL", async () => {
    detachedSetupPage({
      context,
      path: "/?prompt=Start%20my%20first%20task",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(textarea).toHaveValue("Start my first task");
  });

  it("starts a chat draft from a prompt URL", async () => {
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat?prompt=Set%20up%20a%20daily%20report",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    expect(textarea).toHaveValue("Set up a daily report");
  });

  it("starts an optimistic chat from the prompt route", async () => {
    let runPrompt: string | undefined;
    let selectedModel: string | null | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        selectedModel = body.modelSelection?.selectedModel;
      },
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Build%20a%20launch%20recap&connector=slack&model=deepseek-v4-pro",
    });

    await waitFor(() => {
      expect(screen.getByText("Build a launch recap")).toBeInTheDocument();
      expect(runPrompt).toBe("Build a launch recap");
      expect(selectedModel).toBe("deepseek-v4-pro");
    });
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
    let selection:
      | {
          colorSystemId?: string;
          designSystemId: string;
          templateId: string;
          previewUrl?: string;
        }
      | undefined;
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        runPrompt = body.prompt;
        selection =
          body.generationTemplate?.type === "presentation"
            ? body.generationTemplate.selection
            : undefined;
      },
    });

    detachedSetupPage({
      context,
      path: "/prompt?prompt=Make%20a%20launch%20deck&template=presentation-template%3Aplayful-launch-presentation",
    });

    await waitFor(() => {
      expect(screen.getByText("Make a launch deck")).toBeInTheDocument();
      expect(runPrompt).toBe("Make a launch deck");
      expect(selection).toMatchObject({
        colorSystemId: presentationTemplate?.colorSystemId,
        designSystemId: presentationTemplate?.designSystemId,
        templateId: presentationTemplate?.templateId,
        previewUrl: presentationTemplate?.embedUrl,
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
});
