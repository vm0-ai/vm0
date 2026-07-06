import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import { zeroBuiltInGenerationContract } from "@vm0/api-contracts/contracts/zero-built-in-generation";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@vm0/core";

import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000041";
const THREAD_PATH = `/chats/${THREAD_ID}`;
const GENERATION_ID = "d0000000-0000-4000-a000-000000000099";
const SOURCE_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/source.png";
const EDITED_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/edited.png";
const LINK_IMAGE_URL = "https://cdn.vm7.io/artifacts/test/image-edit/link.png";
const IMPORTED_LINK_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/imported-link.png";
const UPLOADED_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/uploaded.png";
const SECOND_UPLOADED_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/uploaded-second.png";
const SOFT_VECTOR_TEMPLATE = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
  return item.slug === "soft-vector";
});
if (!SOFT_VECTOR_TEMPLATE) {
  throw new Error("Missing Soft Vector illustration template");
}

function setupChatThread({
  featureSwitches,
  path = `${THREAD_PATH}?artifact=${encodeURIComponent(SOURCE_IMAGE_URL)}`,
}: {
  featureSwitches?: Parameters<typeof detachedSetupPage>[0]["featureSwitches"];
  path?: string;
}): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);

  const messages: PagedChatMessage[] = [
    {
      id: "msg-image-user",
      role: "user",
      content: "Here is the image",
      runId: "run-image",
      createdAt: "2026-03-10T00:00:00Z",
      attachFiles: [
        {
          id: "artifact-image-edit-source",
          filename: "source.png",
          contentType: "image/png",
          size: 128,
          url: SOURCE_IMAGE_URL,
        },
      ],
    },
    {
      id: "msg-image-assistant",
      role: "assistant",
      content: "Image is ready.",
      runId: "run-image",
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: "msg-image-completed",
      role: "assistant",
      content: null,
      runId: "run-image",
      runLifecycleEvent: "completed",
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: THREAD_ID,
      title: null,
      agentId: AGENT_ID,
      activeRunIds: [],
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceId || query.beforeId) {
      return respond(200, { messages: [] });
    }
    return respond(200, { messages, hasHistoryBefore: false });
  });

  detachedSetupPage({
    context,
    featureSwitches,
    path,
  });
}

function mockImageEditGeneration(
  onGenerate?: (body: {
    prompt?: string;
    sourceImageUrls?: readonly string[];
  }) => void,
): void {
  context.mocks.api(zeroImageIoGenerateContract.post, ({ body, respond }) => {
    onGenerate?.(body);
    return respond(202, {
      generationId: GENERATION_ID,
      type: "image",
      status: "queued",
      realtime: {
        channelName: "gen:image",
        eventName: "update",
        tokenRequest: {
          keyName: "test-key",
          timestamp: 0,
          capability: "{}",
          nonce: "test-nonce",
          mac: "test-mac",
        },
      },
    });
  });
  context.mocks.api(zeroBuiltInGenerationContract.get, ({ respond }) => {
    return respond(200, {
      generationId: GENERATION_ID,
      type: "image",
      status: "completed",
      result: { url: EDITED_IMAGE_URL },
      createdAt: "2026-03-10T00:00:00Z",
      startedAt: "2026-03-10T00:00:01Z",
      completedAt: "2026-03-10T00:00:02Z",
    });
  });
}

function mockImageLinkImport(importedUrl = IMPORTED_LINK_IMAGE_URL): void {
  context.mocks.api(zeroUploadsContract.importImage, ({ respond }) => {
    return respond(200, {
      id: "imported-image-edit-link",
      filename: "imported-link.png",
      contentType: "image/png",
      size: 128,
      url: importedUrl,
    });
  });
}

interface MockUploadResult {
  readonly contentType: string;
  readonly filename: string;
  readonly id: string;
  readonly size: number;
  readonly url: string;
}

function mockSequentialUploads(results: readonly MockUploadResult[]): void {
  let prepareIndex = 0;
  let completeIndex = 0;

  context.mocks.http.post("*/api/zero/uploads/prepare", () => {
    const result = results[prepareIndex];
    if (!result) {
      throw new Error("Missing mock upload prepare result");
    }
    prepareIndex += 1;
    return Response.json({
      ...result,
      uploadUrl: `https://mock-upload.example.com/${result.id}`,
    });
  });
  context.mocks.http.put("https://mock-upload.example.com/*", () => {
    return new Response(null, { status: 200 });
  });
  context.mocks.http.post("*/api/zero/uploads/complete", () => {
    const result = results[completeIndex];
    if (!result) {
      throw new Error("Missing mock upload complete result");
    }
    completeIndex += 1;
    return Response.json(result);
  });
}

function mockPendingImageEditGeneration(
  onGenerate?: (body: {
    prompt?: string;
    sourceImageUrls?: readonly string[];
  }) => void,
): void {
  context.mocks.api(zeroImageIoGenerateContract.post, ({ body, respond }) => {
    onGenerate?.(body);
    return respond(202, {
      generationId: GENERATION_ID,
      type: "image",
      status: "queued",
      realtime: {
        channelName: "gen:image",
        eventName: "update",
        tokenRequest: {
          keyName: "test-key",
          timestamp: 0,
          capability: "{}",
          nonce: "test-nonce",
          mac: "test-mac",
        },
      },
    });
  });
  context.mocks.api(zeroBuiltInGenerationContract.get, ({ respond }) => {
    return respond(200, {
      generationId: GENERATION_ID,
      type: "image",
      status: "queued",
      createdAt: "2026-03-10T00:00:00Z",
      startedAt: null,
      completedAt: null,
    });
  });
}

async function openImageEditMode(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "alt",
      "source.png",
    );
  });

  await user.click(screen.getByLabelText("Preview source.png"));
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "source.png",
    );
  });

  await user.click(screen.getByTestId("image-edit-open"));

  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "alt",
      "source.png",
    );
  });
  expect(screen.queryByTestId("image-edit-toolbar")).toBeNull();
}

async function openSelectedImageEditToolbar(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await openImageEditMode(user);
  await user.click(screen.getByTestId("artifact-sidebar-body-image"));

  await waitFor(() => {
    expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
  });
}

describe("image editing", () => {
  it("adds a remove-background result for the selected canvas image", async () => {
    const user = userEvent.setup({ delay: null });
    mockImageEditGeneration();
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    expect(screen.getByTestId("image-edit-remove-background")).toHaveAttribute(
      "aria-label",
      "Remove background",
    );
    expect(screen.getByTestId("image-edit-enhance")).toHaveAttribute(
      "aria-label",
      "Enhance",
    );
    expect(screen.getByTestId("image-edit-download")).toHaveAttribute(
      "aria-label",
      "Download",
    );
    expect(screen.getByTestId("image-edit-style-transfer")).toHaveAttribute(
      "aria-label",
      "Style Transfer",
    );

    await user.click(screen.getByTestId("image-edit-remove-background"));

    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "src",
      SOURCE_IMAGE_URL,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", EDITED_IMAGE_URL);
    });
  });

  it("applies template and described style transfer prompts", async () => {
    const user = userEvent.setup({ delay: null });
    const prompts: string[] = [];
    mockImageEditGeneration((body) => {
      prompts.push(body.prompt ?? "");
    });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);

    await user.click(screen.getByTestId("image-edit-style-transfer"));
    await waitFor(() => {
      expect(
        screen.getByTestId("image-edit-style-popover"),
      ).toBeInTheDocument();
    });
    const stylePopover = screen.getByTestId("image-edit-style-popover");
    expect(
      within(stylePopover).getByText("Style Transfer"),
    ).toBeInTheDocument();
    expect(within(stylePopover).getByText("Soft Vector")).toBeInTheDocument();
    expect(
      within(stylePopover).queryByText("AI styles"),
    ).not.toBeInTheDocument();
    expect(
      within(stylePopover).queryByText("Illustration templates"),
    ).not.toBeInTheDocument();
    expect(
      within(stylePopover).queryByText("More AI styles"),
    ).not.toBeInTheDocument();
    expect(
      within(stylePopover).queryByText("Templates"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(
        "image-edit-style-template-preview-illustration-soft-vector",
      ),
    ).toHaveAttribute(
      "src",
      SOFT_VECTOR_TEMPLATE.cardPreviewImage ??
        SOFT_VECTOR_TEMPLATE.previewImage,
    );
    await user.click(
      screen.getByTestId("image-edit-style-template-illustration-soft-vector"),
    );
    await user.click(screen.getByTestId("image-edit-apply-style"));

    await waitFor(() => {
      expect(prompts[0]).toContain("Soft Vector illustration template style");
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", EDITED_IMAGE_URL);
    });

    await user.click(screen.getByTestId("image-edit-style-transfer"));
    await user.type(
      screen.getByTestId("image-edit-style-custom-input"),
      "Neon cyberpunk lighting",
    );
    await user.click(screen.getByTestId("image-edit-apply-style"));

    await waitFor(() => {
      expect(prompts[1]).toContain("Neon cyberpunk lighting");
    });
  });

  it("shows image edit progress in a toast instead of toolbar spinners", async () => {
    const user = userEvent.setup({ delay: null });
    const prompts: string[] = [];
    mockImageLinkImport();
    mockPendingImageEditGeneration((body) => {
      prompts.push(body.prompt ?? "");
    });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openImageEditMode(user);
    await user.click(screen.getByTestId("image-edit-upload-menu"));
    await user.type(
      screen.getByTestId("image-edit-upload-link-input"),
      LINK_IMAGE_URL,
    );
    await user.click(screen.getByTestId("image-edit-upload-link-add"));
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", IMPORTED_LINK_IMAGE_URL);
    });

    await user.click(screen.getByTestId("artifact-sidebar-body-image"));
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("image-edit-style-transfer"));
    await user.click(screen.getByTestId("image-edit-apply-style"));

    await waitFor(() => {
      expect(prompts[0]).toContain("Warm analog film look");
      expect(
        screen.getByText("Applying style transfer..."),
      ).toBeInTheDocument();
    });
    expect(
      screen
        .getByText("Applying style transfer...")
        .closest("[data-sonner-toast]"),
    ).toHaveAttribute("data-styled", "true");
    expect(screen.getByTestId("image-edit-style-transfer")).not.toBeDisabled();
    expect(
      screen
        .getByTestId("image-edit-style-transfer")
        .querySelector(".animate-spin"),
    ).toBeNull();

    await user.click(screen.getByTestId("artifact-sidebar-body-image-copy"));
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("image-edit-style-transfer")).not.toBeDisabled();
    expect(
      screen
        .getByTestId("image-edit-style-transfer")
        .querySelector(".animate-spin"),
    ).toBeNull();
  });

  it("edits linked images through the imported artifact URL", async () => {
    const user = userEvent.setup({ delay: null });
    let sourceImageUrls: readonly string[] = [];
    mockImageLinkImport();
    mockImageEditGeneration((body) => {
      sourceImageUrls = body.sourceImageUrls ?? [];
    });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openImageEditMode(user);
    await user.click(screen.getByTestId("image-edit-upload-menu"));
    await user.type(
      screen.getByTestId("image-edit-upload-link-input"),
      LINK_IMAGE_URL,
    );
    await user.click(screen.getByTestId("image-edit-upload-link-add"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", IMPORTED_LINK_IMAGE_URL);
    });

    await user.click(screen.getByTestId("artifact-sidebar-body-image-copy"));
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("image-edit-remove-background"));

    await waitFor(() => {
      expect(sourceImageUrls).toStrictEqual([IMPORTED_LINK_IMAGE_URL]);
    });
  });

  it("only shows the link add action when a URL is entered", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openImageEditMode(user);
    await user.click(screen.getByTestId("image-edit-upload-menu"));

    expect(screen.queryByTestId("image-edit-upload-link-add")).toBeNull();

    const linkInput = screen.getByTestId("image-edit-upload-link-input");
    await user.type(linkInput, LINK_IMAGE_URL);
    expect(
      screen.getByTestId("image-edit-upload-link-add"),
    ).toBeInTheDocument();

    await fill(linkInput, " ");
    expect(screen.queryByTestId("image-edit-upload-link-add")).toBeNull();
  });

  it("exposes share targets and delete from the image edit toolbar", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);

    await user.click(screen.getByTestId("image-edit-share"));
    await waitFor(() => {
      expect(screen.getByText("Share to X")).toBeInTheDocument();
      expect(screen.getByText("Share to Instagram")).toBeInTheDocument();
      expect(screen.getByText("Share to Slack")).toBeInTheDocument();
    });

    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("image-edit-delete"));
    await waitFor(() => {
      expect(screen.queryByTestId("image-edit-toolbar")).toBeNull();
    });
    expect(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-sidebar-body-image")).toBeNull();
  });

  it("adds linked and multiple uploaded local images to the edit canvas", async () => {
    const user = userEvent.setup({ delay: null });
    mockImageLinkImport();
    mockSequentialUploads([
      {
        id: "upload-image-edit-local",
        filename: "local.png",
        contentType: "image/png",
        size: 128,
        url: UPLOADED_IMAGE_URL,
      },
      {
        id: "upload-image-edit-local-second",
        filename: "local-second.png",
        contentType: "image/png",
        size: 128,
        url: SECOND_UPLOADED_IMAGE_URL,
      },
    ]);
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openImageEditMode(user);
    await user.click(screen.getByTestId("image-edit-upload-menu"));
    await user.type(
      screen.getByTestId("image-edit-upload-link-input"),
      LINK_IMAGE_URL,
    );
    await user.click(screen.getByTestId("image-edit-upload-link-add"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", IMPORTED_LINK_IMAGE_URL);
    });

    expect(screen.getByTestId("image-edit-upload-input")).toHaveAttribute(
      "multiple",
    );
    await user.upload(screen.getByTestId("image-edit-upload-input"), [
      new File(["local"], "local.png", { type: "image/png" }),
      new File(["local-second"], "local-second.png", { type: "image/png" }),
    ]);

    await waitFor(() => {
      const copyImageUrls = screen
        .getAllByTestId("artifact-sidebar-body-image-copy")
        .map((image) => {
          return image.getAttribute("src");
        });
      expect(copyImageUrls).toContain(IMPORTED_LINK_IMAGE_URL);
      expect(copyImageUrls).toContain(UPLOADED_IMAGE_URL);
      expect(copyImageUrls).toContain(SECOND_UPLOADED_IMAGE_URL);
    });
  });

  it("keeps the selected image toolbar at screen size after zooming out", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openImageEditMode(user);
    const zoomOutButton = screen.getByTestId("artifact-sidebar-image-zoom-out");
    for (let i = 0; i < 6; i += 1) {
      await user.click(zoomOutButton);
    }
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-image-zoom-level"),
      ).toHaveTextContent("10%");
    });

    await user.click(screen.getByTestId("artifact-sidebar-body-image"));
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });

    expect(screen.getByTestId("image-edit-toolbar-scale").style.transform).toBe(
      "scale(10)",
    );
    expect(
      screen.getByTestId("artifact-sidebar-body-image").style.outlineWidth,
    ).toBe("40px");
  });

  it("hides the edit action when the feature switch is off", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({});

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByLabelText("Preview source.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    expect(screen.queryByTestId("image-edit-open")).toBeNull();
  });

  it("ignores image edit mode from the URL when the feature switch is off", async () => {
    setupChatThread({
      path: `${THREAD_PATH}?artifact=${encodeURIComponent(SOURCE_IMAGE_URL)}&artifact-image-edit=1`,
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    expect(
      screen.queryByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeNull();
    expect(screen.queryByTestId("image-edit-toolbar")).toBeNull();
  });

  it("keeps fullscreen when opening image edit from a fullscreen lightbox", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByLabelText("Preview source.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(
      within(screen.getByTestId("attachment-lightbox")).getByLabelText(
        "Enter fullscreen",
      ),
    );
    await user.click(screen.getByTestId("image-edit-open"));

    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Share artifact")).toBeNull();
    expect(screen.queryByLabelText("Download artifact")).toBeNull();

    await user.click(screen.getByLabelText("Exit fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Enter fullscreen")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "src",
      SOURCE_IMAGE_URL,
    );

    await user.click(screen.getByLabelText("Enter fullscreen"));
    await waitFor(() => {
      expect(screen.getByLabelText("Exit fullscreen")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeInTheDocument();
  });

  it("moves and duplicates the selected image on the edit canvas", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByLabelText("Preview source.png"));
    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByTestId("image-edit-open"));

    const image = screen.getByTestId("artifact-sidebar-body-image");
    fireEvent.pointerDown(image, { button: 0, clientX: 100, clientY: 100 });
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });
    fireEvent.pointerMove(window, { clientX: 130, clientY: 140 });
    fireEvent.pointerUp(window);

    expect(image).toHaveStyle({ left: "470px", top: "370px" });

    fireEvent.keyDown(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
      {
        key: "c",
        metaKey: true,
      },
    );
    fireEvent.keyDown(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
      {
        key: "v",
        metaKey: true,
      },
    );

    expect(
      screen.getByTestId("artifact-sidebar-body-image-copy"),
    ).toHaveAttribute("src", SOURCE_IMAGE_URL);
  });
});
