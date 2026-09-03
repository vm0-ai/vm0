import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";
import { avatarVideoContract } from "@okouai/api-contracts/contracts/avatar-video";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
} from "@okouai/core";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { searchParams$ } from "../../../signals/route.ts";
import { talkDraft$ } from "../../../signals/okou-page/chat-draft.ts";
import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

const DESKTOP_HANDOFF_PARAMS = {
  "intro-video-recording": "video-upload-id",
  "intro-video-recording-name": "demo.mp4",
  "intro-video-recording-size": "1024",
  "intro-video-clicks": "events-upload-id",
  "intro-video-clicks-name": "demo.clicks.json",
  "intro-video-clicks-size": "512",
  "intro-video-user": "test-user-123",
} as const;

const DESKTOP_HANDOFF_SWITCHES = {
  [FeatureSwitchKey.IntroVideo]: true,
  [FeatureSwitchKey.DesktopScreenRecording]: true,
} as const;

function introVideoDialog(): Promise<HTMLElement> {
  return screen.findByRole("dialog", { name: "Create an intro video" });
}

function buttonWithText(
  text: string,
  container: ParentNode,
  exact = true,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((element) => {
    const content = element.textContent?.trim() ?? "";
    return exact ? content === text : content.includes(text);
  });
  if (!button) {
    throw new Error(`Expected button with text: ${text}`);
  }
  return button;
}

function templateFromUserMessage(document: UserMessageDocument | undefined) {
  const part = document?.parts.find((candidate) => {
    return candidate.type === "template";
  });
  return part?.type === "template" ? part.template : undefined;
}

function modelPolicy(
  model: OrgModelPolicy["model"],
  modelLabel: string,
): OrgModelPolicy {
  return {
    id: crypto.randomUUID(),
    model,
    modelLabel,
    isDefault: true,
    defaultProviderType: "built-in",
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

  it("prefills a desktop recording handoff with both uploaded files", async () => {
    let fileUrlRequests = 0;
    context.mocks.http.get("/api/web/file-url", ({ request }) => {
      fileUrlRequests += 1;
      const id = new URL(request.url).searchParams.get("file_id");
      return HttpResponse.json({
        url: `https://resolved.example/${id ?? "missing"}`,
      });
    });
    const params = new URLSearchParams(DESKTOP_HANDOFF_PARAMS);

    detachedSetupPage({
      context,
      path: `/?${params.toString()}`,
      featureSwitches: DESKTOP_HANDOFF_SWITCHES,
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await waitFor(() => {
      expect(textarea).toHaveTextContent(
        "Create a polished intro video from this desktop screen recording.",
      );
      expect(textarea).not.toHaveTextContent("okou video camera");
      expect(context.store.get(talkDraft$).attachments$).toBeDefined();
    });
    const draft = context.store.get(talkDraft$);
    const attachments = context.store.get(draft.attachments$);
    expect(
      attachments.map((attachment) => {
        return {
          filename: attachment.filename,
          size: attachment.size,
        };
      }),
    ).toStrictEqual([
      { filename: "demo.mp4", size: 1024 },
      { filename: "demo.clicks.json", size: 512 },
    ]);
    const fileInfos = await Promise.all(
      attachments.map((attachment) => {
        return context.store.get(attachment.fileInfo$);
      }),
    );
    expect(fileInfos).toStrictEqual([
      {
        id: "video-upload-id",
        url: "https://resolved.example/video-upload-id",
        contentType: "video/mp4",
      },
      {
        id: "events-upload-id",
        url: "https://resolved.example/events-upload-id",
        contentType: "application/json",
      },
    ]);
    expect(
      context.store.get(searchParams$).has("intro-video-recording"),
    ).toBeFalsy();
    expect(context.store.get(draft.agentInstructions$)).toContain(
      "<intro_video_workflow>",
    );
    expect(context.store.get(draft.agentInstructions$)).toContain(
      "okou video camera",
    );

    // The desktop already collected the source, so the handoff lands where an
    // in-browser recording lands: reviewing the take, one step from the avatar.
    const dialog = await introVideoDialog();
    expect(
      within(dialog).getByText("Your source is ready"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("demo.mp4")).toBeInTheDocument();
    // Adopted from the upload, not from bytes this browser never had.
    expect(within(dialog).getByText("In your account")).toBeInTheDocument();
    expect(dialog.querySelector("video")).toHaveAttribute(
      "src",
      "https://resolved.example/video-upload-id",
    );
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();

    // Both files resolve once each, and adopting the recording reuses that
    // resolution instead of signing the preview a second time.
    expect(fileUrlRequests).toBe(2);
  });

  it("keeps a desktop recording when the wizard steps back off the presenter", async () => {
    context.mocks.http.get("/api/web/file-url", ({ request }) => {
      const id = new URL(request.url).searchParams.get("file_id");
      return HttpResponse.json({
        url: `https://resolved.example/${id ?? "missing"}`,
      });
    });
    mockChatLifecycle(context);

    detachedSetupPage({
      context,
      path: `/?${new URLSearchParams(DESKTOP_HANDOFF_PARAMS).toString()}`,
      featureSwitches: DESKTOP_HANDOFF_SWITCHES,
    });

    const dialog = await introVideoDialog();
    await expect(
      within(dialog).findByText("Your source is ready"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();

    click(buttonWithText("Back", dialog, false));

    // Unlike a deck, the take is not thrown away: the browser never held its
    // bytes and the handoff params are already gone, so stepping back lands on
    // its review page with the recording intact.
    await expect(
      within(dialog).findByText("Your source is ready"),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).getByText("demo.mp4")).toBeInTheDocument();

    // Replacing the source opens the picker without spending the take either,
    // so the Source tab can still bring it back.
    click(buttonWithText("Replace source", dialog, false));
    await expect(
      screen.findByText("How do you want to start?"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("Source", dialog, false));
    await expect(
      within(dialog).findByText("Your source is ready"),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).getByText("demo.mp4")).toBeInTheDocument();
  });

  it("sends a desktop recording handoff without uploading it again", async () => {
    const user = userEvent.setup({ delay: null });
    let sentPrompt: string | undefined;
    let sentUserMessage: UserMessageDocument | undefined;
    context.mocks.http.get("/api/web/file-url", ({ request }) => {
      const id = new URL(request.url).searchParams.get("file_id");
      return HttpResponse.json({
        url: `https://resolved.example/${id ?? "missing"}`,
      });
    });
    mockChatLifecycle(context, {
      onSendRequest: ({ prompt, userMessage }) => {
        sentPrompt = prompt;
        sentUserMessage = userMessage;
      },
      onRunCreate: ({ prompt, userMessage }) => {
        sentPrompt = prompt;
        sentUserMessage = userMessage;
      },
    });
    context.mocks.api(avatarVideoContract.voices, ({ respond }) => {
      return respond(200, {
        voices: [],
        hasMore: false,
        filterOptions: { languages: [], useCases: [] },
      });
    });

    detachedSetupPage({
      context,
      path: `/?${new URLSearchParams(DESKTOP_HANDOFF_PARAMS).toString()}`,
      featureSwitches: DESKTOP_HANDOFF_SWITCHES,
    });

    const dialog = await introVideoDialog();
    await expect(
      within(dialog).findByText("Your source is ready"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Choose a voice"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("No voiceover", dialog, false));
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Review your intro video"),
    ).resolves.toBeInTheDocument();
    await user.click(buttonWithText("Create in chat", dialog));

    await waitFor(() => {
      expect(sentPrompt).toContain("- Source: demo.mp4");
      expect(sentPrompt).toContain("- Source type: video");
      // A take from the recorder is edited by the click-driven camera pass, not
      // by the deck workflow the same wizard sends for a slide source.
      expect(sentPrompt).toContain("okou video camera");
    });
    // The recording and its click track ride along as the uploads the desktop
    // already made: no second copy of either file.
    expect(
      sentUserMessage?.parts.filter((part) => {
        return part.type === "file";
      }),
    ).toStrictEqual([
      {
        type: "file",
        fileId: "video-upload-id",
        filenameSnapshot: "demo.mp4",
        contentType: "video/mp4",
      },
      {
        type: "file",
        fileId: "events-upload-id",
        filenameSnapshot: "demo.clicks.json",
        contentType: "application/json",
      },
    ]);
  });

  it("reports a desktop recording owned by another account as unavailable", async () => {
    // The file API answers 404 for an artifact owned by a different user, which
    // is what happens when the desktop was signed in as another account.
    context.mocks.http.get("/api/web/file-url", () => {
      return HttpResponse.json(
        { error: { code: "NOT_FOUND", message: "File not found" } },
        { status: 404 },
      );
    });
    const params = new URLSearchParams({
      "intro-video-recording": "video-upload-id",
      "intro-video-recording-name": "demo.mp4",
      "intro-video-recording-size": "1024",
      "intro-video-clicks": "events-upload-id",
      "intro-video-clicks-name": "demo.clicks.json",
      "intro-video-clicks-size": "512",
      "intro-video-user": "another-user-456",
    });

    detachedSetupPage({
      context,
      path: `/?${params.toString()}`,
      featureSwitches: {
        [FeatureSwitchKey.IntroVideo]: true,
        [FeatureSwitchKey.DesktopScreenRecording]: true,
      },
    });

    await expect(
      screen.findByText(
        "2 attachments are no longer available. Upload them again to send.",
      ),
    ).resolves.toBeInTheDocument();
    const textarea = screen.getByPlaceholderText(
      PLACEHOLDER,
    ) as HTMLTextAreaElement;
    const draft = context.store.get(talkDraft$);

    expect(textarea).not.toHaveTextContent(
      "Create a polished intro video from this desktop screen recording.",
    );
    expect(context.store.get(draft.attachments$)).toHaveLength(0);
    expect(context.store.get(draft.agentInstructions$)).toBeNull();
    expect(
      context.store.get(searchParams$).has("intro-video-recording"),
    ).toBeFalsy();
    // Nothing to review, so the wizard stays shut and the composer banner is
    // the only thing that speaks.
    expect(
      screen.queryByRole("dialog", { name: "Create an intro video" }),
    ).not.toBeInTheDocument();
  });

  it("ignores a desktop recording handoff that omits the file metadata", async () => {
    const params = new URLSearchParams({
      "intro-video-recording": "video-upload-id",
      "intro-video-recording-name": "demo.mp4",
      "intro-video-clicks": "events-upload-id",
      "intro-video-clicks-name": "demo.clicks.json",
      "intro-video-clicks-size": "512",
      "intro-video-user": "test-user-123",
    });

    detachedSetupPage({
      context,
      path: `/agents/c0000000-0000-4000-a000-000000000001/chat?${params.toString()}`,
      featureSwitches: {
        [FeatureSwitchKey.IntroVideo]: true,
        [FeatureSwitchKey.DesktopScreenRecording]: true,
      },
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    const draft = context.store.get(talkDraft$);

    expect(textarea).not.toHaveTextContent(
      "Create a polished intro video from this desktop screen recording.",
    );
    expect(context.store.get(draft.attachments$)).toHaveLength(0);
    expect(context.store.get(draft.agentInstructions$)).toBeNull();
  });

  it.each([
    {
      disabledSwitch: "intro video",
      featureSwitches: {
        [FeatureSwitchKey.IntroVideo]: false,
        [FeatureSwitchKey.DesktopScreenRecording]: true,
      },
    },
    {
      disabledSwitch: "desktop screen recording",
      featureSwitches: {
        [FeatureSwitchKey.IntroVideo]: true,
        [FeatureSwitchKey.DesktopScreenRecording]: false,
      },
    },
  ])(
    "leaves a desktop recording handoff untouched when $disabledSwitch is disabled",
    async ({ featureSwitches }) => {
      const params = new URLSearchParams({
        "intro-video-recording": "video-upload-id",
        "intro-video-recording-name": "demo.mp4",
        "intro-video-recording-size": "1024",
        "intro-video-clicks": "events-upload-id",
        "intro-video-clicks-name": "demo.clicks.json",
        "intro-video-clicks-size": "512",
        "intro-video-user": "test-user-123",
      });

      detachedSetupPage({
        context,
        path: `/agents/c0000000-0000-4000-a000-000000000001/chat?${params.toString()}`,
        featureSwitches,
      });

      const textarea = await waitFor(() => {
        return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
      });
      const draft = context.store.get(talkDraft$);

      expect(textarea).not.toHaveTextContent("okou video camera");
      expect(context.store.get(draft.attachments$)).toHaveLength(0);
      expect(
        context.store.get(searchParams$).get("intro-video-recording"),
      ).toBe("video-upload-id");
    },
  );

  it.each([
    {
      disabledSwitch: "intro video",
      featureSwitches: {
        [FeatureSwitchKey.IntroVideo]: false,
        [FeatureSwitchKey.DesktopScreenRecording]: true,
      },
    },
    {
      disabledSwitch: "desktop screen recording",
      featureSwitches: {
        [FeatureSwitchKey.IntroVideo]: true,
        [FeatureSwitchKey.DesktopScreenRecording]: false,
      },
    },
  ])(
    "does not forward the root desktop handoff when $disabledSwitch is disabled",
    async ({ featureSwitches }) => {
      const params = new URLSearchParams({
        "intro-video-recording": "video-upload-id",
        "intro-video-clicks": "events-upload-id",
        "intro-video-user": "test-user-123",
      });

      detachedSetupPage({
        context,
        path: `/?${params.toString()}`,
        featureSwitches,
      });

      await expect(
        screen.findByPlaceholderText(PLACEHOLDER),
      ).resolves.toBeInTheDocument();
      const draft = context.store.get(talkDraft$);
      expect(context.store.get(draft.attachments$)).toHaveLength(0);
      expect(
        context.store.get(searchParams$).has("intro-video-recording"),
      ).toBeFalsy();
    },
  );

  it("starts an optimistic chat from the prompt route", async () => {
    let runPrompt: string | undefined;
    let userMessage: unknown;
    let createdThreadModel: string | null | undefined;
    context.mocks.data.orgModelPolicies([
      modelPolicy("deepseek-v4-flash", "DeepSeek V4 Flash"),
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
      path: "/prompt?prompt=Build%20a%20launch%20recap&connector=slack&model=deepseek-v4-flash",
    });

    await waitFor(() => {
      expect(screen.getByText("Build a launch recap")).toBeInTheDocument();
      expect(runPrompt).toBe("Build a launch recap");
      expect(userMessage).toStrictEqual({
        version: 1,
        parts: [
          { type: "text", text: "Build a launch recap" },
          { type: "model", selectedModel: "deepseek-v4-flash" },
        ],
      });
      expect(createdThreadModel).toBe("deepseek-v4-flash");
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
        const template = templateFromUserMessage(body.userMessage);
        stylePresetId =
          template?.type === "video"
            ? template.selection.stylePresetId
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
        const template = templateFromUserMessage(body.userMessage);
        selection =
          template?.type === "presentation" ? template.selection : undefined;
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
          { type: "model", selectedModel: "deepseek-v4-flash" },
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
        const template = templateFromUserMessage(body.userMessage);
        illustrationStyleId =
          template?.type === "illustration"
            ? template.selection.illustrationStyleId
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
        const template = templateFromUserMessage(body.userMessage);
        websiteTemplateId =
          template?.type === "website"
            ? template.selection.websiteTemplateId
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
