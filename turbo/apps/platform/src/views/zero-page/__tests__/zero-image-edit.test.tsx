import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import {
  artifactsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
  type ImageArtifactEditSnapshotState,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroImageIoGenerateContract } from "@vm0/api-contracts/contracts/zero-image-io-generate";
import { zeroImageIoInterpretMarksContract } from "@vm0/api-contracts/contracts/zero-image-io-interpret-marks";
import { zeroBuiltInGenerationContract } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000041";
const THREAD_PATH = `/chats/${THREAD_ID}`;
const GENERATION_ID = "d0000000-0000-4000-a000-000000000099";
const SOURCE_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/source.png";
const EDITED_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/edited.png";
const UPLOADED_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/uploaded.png";
const SECOND_UPLOADED_IMAGE_URL =
  "https://cdn.vm7.io/artifacts/test/image-edit/uploaded-second.png";
const STYLE_TRANSFER_TEMPLATES = [
  "Illustration",
  "Anime cell",
  "Watercolor",
  "Risograph",
  "Papercut",
  "Studio production",
  "Notion",
  "Ink wash",
  "Clay",
] as const;
const STYLE_TRANSFER_TEMPLATE_TEST_IDS = [
  "image-edit-style-template-illustration",
  "image-edit-style-template-anime-cell",
  "image-edit-style-template-watercolor",
  "image-edit-style-template-risograph",
  "image-edit-style-template-papercut",
  "image-edit-style-template-studio-production",
  "image-edit-style-template-notion",
  "image-edit-style-template-ink-wash",
  "image-edit-style-template-clay",
] as const;
const REMOVED_STYLE_TRANSFER_TEMPLATES = [
  "Warm film",
  "Soft Vector",
  "Grain Poster",
  "Sunlit Gouache",
  "Editorial",
  "Neon noir",
  "Vintage comic",
] as const;

afterEach(() => {
  window.location.href = "http://localhost/";
});

function setupChatThread({
  featureSwitches,
  onImageEditSnapshotDelete,
  onImageEditSnapshotUpsert,
  path = `${THREAD_PATH}?artifact=${encodeURIComponent(SOURCE_IMAGE_URL)}`,
  persistedImageEditSnapshot = null,
}: {
  featureSwitches?: Parameters<typeof detachedSetupPage>[0]["featureSwitches"];
  onImageEditSnapshotDelete?: (query: { readonly url: string }) => void;
  onImageEditSnapshotUpsert?: (body: {
    readonly snapshot: ImageArtifactEditSnapshotState;
    readonly url: string;
  }) => void;
  path?: string;
  persistedImageEditSnapshot?: ImageArtifactEditSnapshotState | null;
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
      lastReadAt: null,
      computerUseHostId: null,
      codexServiceTier: null,
    });
  });
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceId || query.beforeId) {
      return respond(200, { messages: [] });
    }
    return respond(200, { messages, hasHistoryBefore: false });
  });
  let currentPersistedImageEditSnapshot = persistedImageEditSnapshot;
  context.mocks.api(artifactsContract.getImageEditSnapshot, ({ respond }) => {
    return respond(200, {
      snapshot: currentPersistedImageEditSnapshot
        ? {
            artifactUrl: SOURCE_IMAGE_URL,
            snapshot: currentPersistedImageEditSnapshot,
            updatedAt: "2026-03-10T00:00:03.000Z",
          }
        : null,
    });
  });
  context.mocks.api(
    artifactsContract.upsertImageEditSnapshot,
    ({ body, respond }) => {
      currentPersistedImageEditSnapshot = body.snapshot;
      onImageEditSnapshotUpsert?.(body);
      return respond(200, {
        artifactUrl: body.url,
        snapshot: body.snapshot,
        updatedAt: "2026-03-10T00:00:03.000Z",
      });
    },
  );
  context.mocks.api(
    artifactsContract.deleteImageEditSnapshot,
    ({ query, respond }) => {
      currentPersistedImageEditSnapshot = null;
      onImageEditSnapshotDelete?.(query);
      return respond(204);
    },
  );

  detachedSetupPage({
    context,
    featureSwitches,
    path,
  });
}

function mockImageEditGeneration(
  onGenerate?: (body: {
    maskImageUrl?: string;
    model?: string;
    outputFormat?: string;
    prompt?: string;
    size?: string;
    sourceImageUrls?: readonly string[];
  }) => void,
  options?: { resultReady?: Promise<void> },
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
  context.mocks.api(zeroBuiltInGenerationContract.get, async ({ respond }) => {
    if (options?.resultReady) {
      await options.resultReady;
    }
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
    maskImageUrl?: string;
    model?: string;
    outputFormat?: string;
    prompt?: string;
    size?: string;
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

const MARKED_DATA_URI = "data:image/png;base64,bWFya2Vk";

// Region editing loads the source image and draws a downscaled copy with a
// numbered outline over each region to a data URI. jsdom neither loads <img>
// nor renders <canvas>, so stub image loading (fire onload) and the 2d context
// (no-op drawing calls, return a fixed data URI).
function mockImageEditMarkedCanvas(): void {
  const getContextDescriptor = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  const toDataURLDescriptor = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "toDataURL",
  );
  const srcDescriptor = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "src",
  );

  const canvasContext = {
    drawImage: () => {},
    strokeRect: () => {},
    fillRect: () => {},
    fillText: () => {},
    measureText: () => {
      return { width: 12 } as TextMetrics;
    },
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    font: "",
    textBaseline: "",
  } as unknown as CanvasRenderingContext2D;

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: (contextId: string) => {
      return contextId === "2d" ? canvasContext : null;
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: () => {
      return MARKED_DATA_URI;
    },
  });
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    set(this: HTMLImageElement, value: string) {
      this.setAttribute("src", value);
      queueMicrotask(() => {
        this.dispatchEvent(new Event("load"));
      });
    },
    get(this: HTMLImageElement) {
      return this.getAttribute("src") ?? "";
    },
  });

  context.signal.addEventListener(
    "abort",
    () => {
      const restore = (
        proto: object,
        name: string,
        descriptor: PropertyDescriptor | undefined,
      ) => {
        if (descriptor) {
          Object.defineProperty(proto, name, descriptor);
        } else {
          Reflect.deleteProperty(proto, name);
        }
      };
      restore(HTMLCanvasElement.prototype, "getContext", getContextDescriptor);
      restore(HTMLCanvasElement.prototype, "toDataURL", toDataURLDescriptor);
      restore(HTMLImageElement.prototype, "src", srcDescriptor);
    },
    { once: true },
  );
}

interface MockInterpretRegion {
  readonly id: string;
  readonly mark: number;
  readonly instruction: string;
  readonly location?: string;
}

// Echo each region back as a resolved edit so the downstream generation prompt
// carries a target + instruction per mark.
function mockInterpretMarks(
  onRequest?: (body: {
    imageUrl: string;
    regions: readonly MockInterpretRegion[];
  }) => void,
): void {
  context.mocks.api(
    zeroImageIoInterpretMarksContract.post,
    ({ body, respond }) => {
      onRequest?.(body);
      return respond(200, {
        regions: body.regions.map((region) => {
          return {
            id: region.id,
            target: `marked area ${region.mark}`,
            edit: region.instruction,
            confidence: 90,
          };
        }),
      });
    },
  );
}

function mockElementClientSize(
  element: HTMLElement,
  size: { readonly height: number; readonly width: number },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: size.height },
    clientWidth: { configurable: true, value: size.width },
  });
}

function domRect({
  height,
  left = 0,
  top = 0,
  width,
}: {
  readonly height: number;
  readonly left?: number;
  readonly top?: number;
  readonly width: number;
}): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => {
      return {};
    },
    top,
    width,
    x: left,
    y: top,
  };
}

function mockElementLayoutBox(
  element: HTMLElement,
  rect: {
    readonly height: number;
    readonly left?: number;
    readonly top?: number;
    readonly width: number;
  },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: rect.height },
    clientWidth: { configurable: true, value: rect.width },
    offsetHeight: { configurable: true, value: rect.height },
    offsetWidth: { configurable: true, value: rect.width },
  });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return domRect(rect);
    },
  });
}

function transformNumbers(transform: string): readonly number[] {
  const matches = transform.match(/-?\d+(?:\.\d+)?/g);
  return matches?.map(Number) ?? [];
}

function mockImageNaturalSize(
  image: HTMLImageElement,
  size: { readonly height: number; readonly width: number },
): void {
  Object.defineProperties(image, {
    naturalHeight: { configurable: true, value: size.height },
    naturalWidth: { configurable: true, value: size.width },
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

async function exitImageEditMode(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByTestId("artifact-sidebar-exit-image-edit"));
  await waitFor(() => {
    expect(
      screen.queryByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeNull();
  });
}

async function reopenImageEditMode(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const visibleEditButton = screen.queryByTestId("image-edit-open");
  if (visibleEditButton instanceof HTMLElement) {
    await user.click(visibleEditButton);
  } else {
    await user.click(screen.getByLabelText("Preview source.png"));
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-open")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("image-edit-open"));
  }

  await waitFor(() => {
    expect(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeInTheDocument();
  });
}

async function exitAndReopenImageEditMode(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await exitImageEditMode(user);
  await reopenImageEditMode(user);
}

async function createRegionComment(
  user: ReturnType<typeof userEvent.setup>,
  instruction: string,
): Promise<void> {
  await user.click(screen.getByTestId("image-edit-select-region"));

  const image = screen.getByTestId("artifact-sidebar-body-image");
  image.getBoundingClientRect = () => {
    return {
      bottom: 560,
      height: 540,
      left: 10,
      right: 730,
      top: 20,
      width: 720,
      x: 10,
      y: 20,
      toJSON: () => {
        return {};
      },
    };
  };

  fireEvent.pointerDown(image, { button: 0, clientX: 90, clientY: 110 });
  fireEvent.pointerMove(window, { clientX: 270, clientY: 260 });
  fireEvent.pointerUp(window);

  await waitFor(() => {
    expect(
      screen.getByTestId("image-edit-region-comment-form"),
    ).toBeInTheDocument();
  });
  await user.type(
    screen.getByTestId("image-edit-region-comment-input"),
    instruction,
  );
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(screen.getByTestId("image-edit-region-comment")).toHaveAttribute(
      "title",
      instruction,
    );
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
    expect(
      Array.from(
        screen
          .getByTestId("image-edit-toolbar")
          .querySelectorAll("[data-testid]"),
      ).map((element) => {
        return element instanceof HTMLElement
          ? element.dataset.testid
          : undefined;
      }),
    ).toStrictEqual([
      "image-edit-select-region",
      "image-edit-actions-group",
      "image-edit-remove-background",
      "image-edit-enhance",
      "image-edit-style-transfer",
      "image-edit-copy-download-group",
      "image-edit-copy-link",
      "image-edit-download",
      "image-edit-delete",
    ]);
    expect(screen.getByTestId("image-edit-actions-group")).toHaveAttribute(
      "role",
      "group",
    );
    expect(screen.getByTestId("image-edit-actions-group")).toHaveClass(
      "overflow-hidden",
      "rounded-lg",
    );
    expect(
      Array.from(
        screen
          .getByTestId("image-edit-actions-group")
          .querySelectorAll("[data-testid]"),
      ).map((element) => {
        return element instanceof HTMLElement
          ? element.dataset.testid
          : undefined;
      }),
    ).toStrictEqual([
      "image-edit-remove-background",
      "image-edit-enhance",
      "image-edit-style-transfer",
    ]);
    expect(
      screen.getByTestId("image-edit-copy-download-group"),
    ).toHaveAttribute("role", "group");
    expect(screen.getByTestId("image-edit-copy-download-group")).toHaveClass(
      "overflow-hidden",
      "rounded-lg",
    );
    expect(
      Array.from(
        screen
          .getByTestId("image-edit-copy-download-group")
          .querySelectorAll("[data-testid]"),
      ).map((element) => {
        return element instanceof HTMLElement
          ? element.dataset.testid
          : undefined;
      }),
    ).toStrictEqual(["image-edit-copy-link", "image-edit-download"]);
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
    expect(screen.getByTestId("image-edit-copy-link")).toHaveAttribute(
      "aria-label",
      "Copy link",
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

  it("restores a generated image after exiting and reopening image edit mode", async () => {
    const user = userEvent.setup({ delay: null });
    mockImageEditGeneration();
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    await user.click(screen.getByTestId("image-edit-remove-background"));
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", EDITED_IMAGE_URL);
    });

    await exitAndReopenImageEditMode(user);

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", EDITED_IMAGE_URL);
    });
  });

  it("interprets marked regions and applies all comments in one edited image", async () => {
    const user = userEvent.setup({ delay: null });
    const prompts: string[] = [];
    const models: string[] = [];
    const outputFormats: string[] = [];
    const sizes: string[] = [];
    const sourceImageUrls: (readonly string[])[] = [];
    const interpretRequests: {
      imageUrl: string;
      regions: readonly MockInterpretRegion[];
    }[] = [];
    const imageEditResultReady = createDeferredPromise<void>(context.signal);
    mockImageEditMarkedCanvas();
    mockInterpretMarks((body) => {
      interpretRequests.push(body);
    });
    mockImageEditGeneration(
      (body) => {
        models.push(body.model ?? "");
        outputFormats.push(body.outputFormat ?? "");
        prompts.push(body.prompt ?? "");
        sizes.push(body.size ?? "");
        sourceImageUrls.push(body.sourceImageUrls ?? []);
      },
      { resultReady: imageEditResultReady.promise },
    );
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    expect(screen.getByTestId("image-edit-select-region")).toHaveAttribute(
      "aria-label",
      "Select area",
    );
    await user.click(screen.getByTestId("image-edit-select-region"));

    expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("image-edit-select-region")).toHaveClass(
      "bg-primary",
    );
    expect(
      screen.getByTestId("artifact-sidebar-image-zoom-controls"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("image-edit-upload-local")).toBeInTheDocument();
    expect(screen.getByTestId("image-edit-select-region")).toHaveAttribute(
      "aria-label",
      "Cancel area selection",
    );

    const image = screen.getByTestId("artifact-sidebar-body-image");
    image.getBoundingClientRect = () => {
      return {
        bottom: 560,
        height: 540,
        left: 10,
        right: 730,
        top: 20,
        width: 720,
        x: 10,
        y: 20,
        toJSON: () => {
          return {};
        },
      };
    };

    fireEvent.pointerDown(image, { button: 0, clientX: 90, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 270, clientY: 260 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(
        screen.getByTestId("image-edit-region-comment-form"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    expect(screen.queryByTestId("image-edit-region-remove")).toBeNull();
    expect(screen.getByTestId("image-edit-upload-local")).toBeInTheDocument();
    expect(screen.queryByTestId("image-edit-region-send")).toBeNull();

    const commentInput = screen.getByTestId("image-edit-region-comment-input");
    expect(commentInput).toHaveAttribute("autocomplete", "off");
    expect(commentInput).not.toHaveAttribute("name");
    // Bounded to the interpret-marks contract's instruction limit so an
    // over-length instruction can't reach the API as a 400.
    expect(commentInput).toHaveAttribute("maxlength", "2000");

    await user.type(commentInput, "Remove the logo");
    expect(prompts).toStrictEqual([]);
    expect(screen.queryByTestId("image-edit-region-comment")).toBeNull();

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-region-comment")).toHaveAttribute(
        "aria-label",
        "Edit comment: Remove the logo",
      );
      expect(screen.getByTestId("image-edit-region-comment")).toHaveAttribute(
        "title",
        "Remove the logo",
      );
    });
    expect(screen.queryByTestId("image-edit-region-selection")).toBeNull();
    expect(screen.getByTestId("image-edit-region-comment-frame")).toHaveClass(
      "border-primary/90",
      "bg-primary/10",
      "border-dashed",
      "opacity-0",
    );
    expect(
      screen
        .getByTestId("image-edit-region-comment-frame")
        .getAttribute("class"),
    ).toContain("group-hover:opacity-100");
    expect(
      screen.getByTestId("image-edit-region-comment-content"),
    ).toHaveTextContent("Remove the logo");

    await user.click(screen.getByTestId("image-edit-region-comment-edit"));
    await waitFor(() => {
      expect(
        screen.getByTestId("image-edit-region-comment-form"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("image-edit-region-comment")).toBeNull();
    expect(screen.getByTestId("image-edit-region-comment-input")).toHaveValue(
      "Remove the logo",
    );
    await fill(
      screen.getByTestId("image-edit-region-comment-input"),
      "Remove the small logo",
    );
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByTestId("image-edit-region-comment")).toHaveAttribute(
        "title",
        "Remove the small logo",
      );
    });
    expect(screen.queryByTestId("image-edit-region-comment-input")).toBeNull();
    expect(screen.getByTestId("image-edit-select-region")).toHaveAttribute(
      "aria-label",
      "Cancel area selection",
    );
    expect(screen.getByTestId("image-edit-select-region")).toHaveClass(
      "bg-primary",
    );
    expect(screen.getByTestId("image-edit-region-comment-clear")).toHaveClass(
      "opacity-0",
    );
    expect(
      screen
        .getByTestId("image-edit-region-comment-clear")
        .getAttribute("class"),
    ).toContain("group-hover:opacity-100");

    fireEvent.pointerDown(image, { button: 0, clientX: 320, clientY: 190 });
    fireEvent.pointerMove(window, { clientX: 440, clientY: 300 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(
        screen.getByTestId("image-edit-region-comment-form"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("image-edit-region-comment")).toBeNull();

    await user.type(
      screen.getByTestId("image-edit-region-comment-input"),
      "Make the badge blue",
    );
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getAllByTestId("image-edit-region-comment")).toHaveLength(
        2,
      );
    });
    expect(
      screen.getByLabelText("Edit comment: Remove the small logo"),
    ).toHaveAttribute("title", "Remove the small logo");
    expect(
      screen.getByLabelText("Edit comment: Make the badge blue"),
    ).toHaveAttribute("title", "Make the badge blue");

    const sendButton = screen.getByTestId("image-edit-region-send");
    expect(sendButton).toHaveAttribute("aria-label", "Send edit instruction");
    expect(sendButton).toHaveTextContent("Send");
    expect(sendButton).not.toBeDisabled();

    await user.click(sendButton);

    await waitFor(() => {
      expect(sendButton).toHaveTextContent("Working");
    });
    expect(sendButton).toBeDisabled();
    imageEditResultReady.resolve();

    // One understanding pass over the marked image, then a single generation
    // that applies every resolved instruction to the clean source image.
    await waitFor(() => {
      expect(prompts).toHaveLength(1);
    });
    expect(interpretRequests).toHaveLength(1);
    expect(interpretRequests[0]?.imageUrl).toBe(MARKED_DATA_URI);
    expect(
      interpretRequests[0]?.regions.map((region) => {
        return { mark: region.mark, instruction: region.instruction };
      }),
    ).toStrictEqual([
      { mark: 1, instruction: "Remove the small logo" },
      { mark: 2, instruction: "Make the badge blue" },
    ]);
    expect(prompts[0]).toContain("Remove the small logo");
    expect(prompts[0]).toContain("Make the badge blue");
    expect(prompts[0]).toContain("marked area 1");
    expect(prompts[0]).toContain("marked area 2");
    expect(models).toStrictEqual(["nano-banana-2"]);
    expect(outputFormats[0]).toBe("png");
    expect(sizes[0]).toBe("auto");
    expect(sourceImageUrls[0]).toStrictEqual([SOURCE_IMAGE_URL]);
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "src",
      SOURCE_IMAGE_URL,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", EDITED_IMAGE_URL);
    });
    expect(screen.queryByTestId("image-edit-region-comment")).toBeNull();
    // A multi-edit single pass can silently skip an edit; the user is told to
    // verify rather than left assuming all applied.
    await waitFor(() => {
      expect(
        screen.getByText(/Applied 2 edits — check the result/),
      ).toBeInTheDocument();
    });
  });

  it("keeps region comments when the single region edit fails", async () => {
    const user = userEvent.setup({ delay: null });
    mockImageEditMarkedCanvas();
    mockInterpretMarks();
    context.mocks.api(zeroImageIoGenerateContract.post, ({ respond }) => {
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
        status: "failed",
        error: { code: "generation_failed", message: "boom" },
        createdAt: "2026-03-10T00:00:00Z",
        startedAt: "2026-03-10T00:00:01Z",
        completedAt: "2026-03-10T00:00:02Z",
      });
    });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    await user.click(screen.getByTestId("image-edit-select-region"));

    const image = screen.getByTestId("artifact-sidebar-body-image");
    image.getBoundingClientRect = () => {
      return {
        bottom: 560,
        height: 540,
        left: 10,
        right: 730,
        top: 20,
        width: 720,
        x: 10,
        y: 20,
        toJSON: () => {
          return {};
        },
      };
    };

    fireEvent.pointerDown(image, { button: 0, clientX: 90, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 270, clientY: 260 });
    fireEvent.pointerUp(window);
    await waitFor(() => {
      expect(
        screen.getByTestId("image-edit-region-comment-form"),
      ).toBeInTheDocument();
    });
    await user.type(
      screen.getByTestId("image-edit-region-comment-input"),
      "Remove the logo",
    );
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-region-comment")).toHaveAttribute(
        "title",
        "Remove the logo",
      );
    });

    await user.click(screen.getByTestId("image-edit-region-send"));

    // The single-pass edit failed, so the comment is kept for a retry.
    await waitFor(() => {
      expect(
        screen.getByText("Couldn't edit the image, try again"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("image-edit-region-comment")).toHaveAttribute(
      "title",
      "Remove the logo",
    );
    expect(screen.queryByTestId("artifact-sidebar-body-image-copy")).toBeNull();
  });

  it("cancels pending region comment editing without leaving select area on the current image", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    await user.click(screen.getByTestId("image-edit-select-region"));

    const image = screen.getByTestId("artifact-sidebar-body-image");
    image.getBoundingClientRect = () => {
      return {
        bottom: 560,
        height: 540,
        left: 10,
        right: 730,
        top: 20,
        width: 720,
        x: 10,
        y: 20,
        toJSON: () => {
          return {};
        },
      };
    };

    fireEvent.pointerDown(image, { button: 0, clientX: 90, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 270, clientY: 260 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(
        screen.getByTestId("image-edit-region-comment-form"),
      ).toBeInTheDocument();
    });

    fireEvent.pointerDown(image, { button: 0, clientX: 320, clientY: 320 });

    await waitFor(() => {
      expect(screen.queryByTestId("image-edit-region-comment-form")).toBeNull();
    });
    expect(screen.queryByTestId("image-edit-region-comment")).toBeNull();
    expect(screen.getByTestId("image-edit-select-region")).toHaveAttribute(
      "aria-label",
      "Cancel area selection",
    );
    expect(screen.getByTestId("image-edit-select-region")).toHaveClass(
      "bg-primary",
    );

    fireEvent.pointerDown(image, { button: 0, clientX: 120, clientY: 140 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 240 });
    fireEvent.pointerUp(window);

    await waitFor(() => {
      expect(
        screen.getByTestId("image-edit-region-comment-form"),
      ).toBeInTheDocument();
    });

    fireEvent.pointerDown(
      screen.getByTestId("artifact-sidebar-image-edit-canvas-surface"),
      { button: 0 },
    );

    await waitFor(() => {
      expect(screen.queryByTestId("image-edit-region-comment-form")).toBeNull();
    });
    expect(screen.queryByTestId("image-edit-select-region")).toBeNull();
  });

  it("keeps comments across fullscreen, skips comments on copy, and clears them on exit", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    await createRegionComment(user, "Make the collar red");

    await user.click(screen.getByTestId("artifact-sidebar-fullscreen-toggle"));
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-fullscreen-toggle"),
      ).toHaveAttribute("aria-label", "Exit fullscreen");
    });
    expect(screen.getByTestId("image-edit-region-comment")).toHaveAttribute(
      "title",
      "Make the collar red",
    );

    await user.click(screen.getByTestId("artifact-sidebar-fullscreen-toggle"));
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-fullscreen-toggle"),
      ).toHaveAttribute("aria-label", "Enter fullscreen");
    });
    expect(screen.getByTestId("image-edit-region-comment")).toHaveAttribute(
      "title",
      "Make the collar red",
    );

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

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", SOURCE_IMAGE_URL);
    });
    expect(screen.getAllByTestId("image-edit-region-comment")).toHaveLength(1);

    await user.click(screen.getByTestId("artifact-sidebar-exit-image-edit"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("artifact-sidebar-image-edit-canvas"),
      ).toBeNull();
    });
    expect(screen.queryByTestId("image-edit-region-comment")).toBeNull();
  });

  it("removes comments when their image is deleted", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    await createRegionComment(user, "Remove the tag");

    await user.click(screen.getByTestId("image-edit-delete"));

    await waitFor(() => {
      expect(screen.queryByTestId("image-edit-region-comment")).toBeNull();
    });
  });

  it("does not restore a deleted generated image after reopening", async () => {
    const user = userEvent.setup({ delay: null });
    mockImageEditGeneration();
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    await user.click(screen.getByTestId("image-edit-remove-background"));
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", EDITED_IMAGE_URL);
    });

    await user.click(screen.getByTestId("image-edit-delete"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("artifact-sidebar-body-image-copy"),
      ).toBeNull();
    });

    await exitAndReopenImageEditMode(user);

    expect(screen.queryByTestId("artifact-sidebar-body-image-copy")).toBeNull();
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "src",
      SOURCE_IMAGE_URL,
    );
  });

  it("does not touch persistence when exiting an unmodified source image", async () => {
    const user = userEvent.setup({ delay: null });
    const deletedSnapshots: { readonly url: string }[] = [];
    const savedSnapshots: {
      readonly snapshot: ImageArtifactEditSnapshotState;
      readonly url: string;
    }[] = [];
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
      onImageEditSnapshotDelete: (query) => {
        deletedSnapshots.push(query);
      },
      onImageEditSnapshotUpsert: (body) => {
        savedSnapshots.push(body);
      },
    });

    await openImageEditMode(user);
    await exitImageEditMode(user);

    expect(savedSnapshots).toStrictEqual([]);
    expect(deletedSnapshots).toStrictEqual([]);
  });

  it("clears persisted snapshot after deleting back to only the source image", async () => {
    const user = userEvent.setup({ delay: null });
    const deletedSnapshots: { readonly url: string }[] = [];
    const savedSnapshots: {
      readonly snapshot: ImageArtifactEditSnapshotState;
      readonly url: string;
    }[] = [];
    mockImageEditGeneration();
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
      onImageEditSnapshotDelete: (query) => {
        deletedSnapshots.push(query);
      },
      onImageEditSnapshotUpsert: (body) => {
        savedSnapshots.push(body);
      },
    });

    await openSelectedImageEditToolbar(user);
    await user.click(screen.getByTestId("image-edit-remove-background"));
    await waitFor(() => {
      expect(savedSnapshots.at(-1)?.snapshot.items).toHaveLength(2);
    });

    await user.click(screen.getByTestId("image-edit-delete"));
    await waitFor(() => {
      expect(deletedSnapshots).toContainEqual({ url: SOURCE_IMAGE_URL });
    });
    expect(savedSnapshots.at(-1)?.snapshot.items).toHaveLength(2);
  });

  it("restores the source image after the last image is deleted", async () => {
    const user = userEvent.setup({ delay: null });
    const deletedSnapshots: { readonly url: string }[] = [];
    const savedSnapshots: {
      readonly snapshot: ImageArtifactEditSnapshotState;
      readonly url: string;
    }[] = [];
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
      onImageEditSnapshotDelete: (query) => {
        deletedSnapshots.push(query);
      },
      onImageEditSnapshotUpsert: (body) => {
        savedSnapshots.push(body);
      },
      persistedImageEditSnapshot: {
        items: [{ url: SOURCE_IMAGE_URL, x: 440, y: 330, zIndex: 1 }],
        version: 1,
      },
    });

    await openSelectedImageEditToolbar(user);
    await user.click(screen.getByTestId("image-edit-delete"));
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar-body-image")).toBeNull();
    });
    await waitFor(() => {
      expect(deletedSnapshots).toContainEqual({ url: SOURCE_IMAGE_URL });
    });
    expect(savedSnapshots).toStrictEqual([]);

    await exitAndReopenImageEditMode(user);

    expect(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
      "src",
      SOURCE_IMAGE_URL,
    );
    expect(screen.queryByTestId("artifact-sidebar-body-image-copy")).toBeNull();
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
    for (const templateName of STYLE_TRANSFER_TEMPLATES) {
      expect(within(stylePopover).getByText(templateName)).toBeInTheDocument();
    }
    expect(
      Array.from(
        stylePopover.querySelectorAll(
          'label[data-testid^="image-edit-style-template-"]',
        ),
      ).map((element) => {
        return element instanceof HTMLElement
          ? element.dataset.testid
          : undefined;
      }),
    ).toStrictEqual([...STYLE_TRANSFER_TEMPLATE_TEST_IDS]);
    for (const templateName of REMOVED_STYLE_TRANSFER_TEMPLATES) {
      expect(within(stylePopover).queryByText(templateName)).toBeNull();
    }
    expect(within(stylePopover).queryByText(/Same motif/u)).toBeNull();
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
      screen.getByTestId("image-edit-style-template-preview-ink-wash"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("image-edit-style-template-preview-studio-production"),
    ).toBeInTheDocument();
    for (const templateName of STYLE_TRANSFER_TEMPLATES) {
      expect(
        within(stylePopover).getByRole("radio", {
          name: new RegExp(templateName, "u"),
        }),
      ).not.toBeChecked();
    }
    expect(
      within(stylePopover).getByRole("radio", { name: /Custom style/u }),
    ).not.toBeChecked();
    expect(screen.getByTestId("image-edit-apply-style")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(
      screen.getByTestId("image-edit-style-template-studio-production"),
    );
    expect(
      within(stylePopover).getByRole("radio", {
        name: /Studio production/u,
      }),
    ).toBeChecked();
    expect(
      within(stylePopover).getByRole("radio", { name: /Custom style/u }),
    ).not.toBeChecked();
    expect(screen.getByTestId("image-edit-apply-style")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await user.click(screen.getByTestId("image-edit-apply-style"));

    await waitFor(() => {
      expect(prompts[0]).toContain("Polished studio production style");
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
    expect(
      within(screen.getByTestId("image-edit-style-popover")).getByRole(
        "radio",
        { name: /Custom style/u },
      ),
    ).toBeChecked();
    await user.click(screen.getByTestId("image-edit-apply-style"));

    await waitFor(() => {
      expect(prompts[1]).toContain("Neon cyberpunk lighting");
    });
  });

  it("shows image edit progress in a toast instead of toolbar spinners", async () => {
    const user = userEvent.setup({ delay: null });
    const prompts: string[] = [];
    mockSequentialUploads([
      {
        id: "upload-image-edit-progress",
        filename: "progress.png",
        contentType: "image/png",
        size: 128,
        url: UPLOADED_IMAGE_URL,
      },
    ]);
    mockPendingImageEditGeneration((body) => {
      prompts.push(body.prompt ?? "");
    });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openImageEditMode(user);
    await user.upload(
      screen.getByTestId("image-edit-upload-input"),
      new File(["progress"], "progress.png", { type: "image/png" }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", UPLOADED_IMAGE_URL);
    });

    await user.click(screen.getByTestId("artifact-sidebar-body-image"));
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("image-edit-style-transfer"));
    await user.click(
      screen.getByTestId("image-edit-style-template-illustration"),
    );
    await user.click(screen.getByTestId("image-edit-apply-style"));

    await waitFor(() => {
      expect(prompts[0]).toContain("Clean vector illustration style");
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

  it("edits uploaded images through the uploaded artifact URL", async () => {
    const user = userEvent.setup({ delay: null });
    let sourceImageUrls: readonly string[] = [];
    mockSequentialUploads([
      {
        id: "upload-image-edit-source",
        filename: "source-copy.png",
        contentType: "image/png",
        size: 128,
        url: UPLOADED_IMAGE_URL,
      },
    ]);
    mockImageEditGeneration((body) => {
      sourceImageUrls = body.sourceImageUrls ?? [];
    });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openImageEditMode(user);
    await user.upload(
      screen.getByTestId("image-edit-upload-input"),
      new File(["source-copy"], "source-copy.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toHaveAttribute("src", UPLOADED_IMAGE_URL);
    });

    await user.click(screen.getByTestId("artifact-sidebar-body-image-copy"));
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("image-edit-remove-background"));

    await waitFor(() => {
      expect(sourceImageUrls).toStrictEqual([UPLOADED_IMAGE_URL]);
    });
  });

  it("shows only the local image upload control in image edit mode", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openImageEditMode(user);

    expect(screen.getByTestId("image-edit-upload-local")).toHaveAttribute(
      "aria-label",
      "Upload from computer",
    );
    expect(screen.getByTestId("image-edit-upload-input")).toHaveAttribute(
      "multiple",
    );
    expect(screen.queryByTestId("image-edit-upload-menu")).toBeNull();
    expect(screen.queryByTestId("image-edit-upload-popover")).toBeNull();
    expect(screen.queryByTestId("image-edit-upload-link-input")).toBeNull();
    expect(screen.queryByTestId("image-edit-upload-link-add")).toBeNull();
  });

  it("copies the image link and deletes from the image edit toolbar", async () => {
    const user = userEvent.setup({ delay: null });
    const clipboard = context.mocks.browser.clipboardWriteText();
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);

    await user.click(screen.getByTestId("image-edit-copy-link"));
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([SOURCE_IMAGE_URL]);
      expect(screen.getByText("Link copied")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("image-edit-delete"));
    await waitFor(() => {
      expect(screen.queryByTestId("image-edit-toolbar")).toBeNull();
    });
    expect(
      screen.getByTestId("artifact-sidebar-image-edit-canvas"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-sidebar-body-image")).toBeNull();
  });

  it("adds multiple uploaded local images to the edit canvas", async () => {
    const user = userEvent.setup({ delay: null });
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
      expect(copyImageUrls).toContain(UPLOADED_IMAGE_URL);
      expect(copyImageUrls).toContain(SECOND_UPLOADED_IMAGE_URL);
    });

    await exitAndReopenImageEditMode(user);

    await waitFor(() => {
      const copyImageUrls = screen
        .getAllByTestId("artifact-sidebar-body-image-copy")
        .map((image) => {
          return image.getAttribute("src");
        });
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

  it("opens image edit from the split-view artifact header", async () => {
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

    await user.click(screen.getByTestId("artifact-sidebar-edit-image"));

    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-image-edit-canvas"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Share artifact")).toBeNull();
    expect(screen.queryByLabelText("Download artifact")).toBeNull();
  });

  it("fits the initial edit image to the visible canvas area", async () => {
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

    await user.click(screen.getByTestId("artifact-sidebar-edit-image"));
    const canvas = await screen.findByTestId(
      "artifact-sidebar-image-edit-canvas",
    );
    mockElementClientSize(canvas, { height: 300, width: 400 });

    const image = screen.getByTestId("artifact-sidebar-body-image");
    if (!(image instanceof HTMLImageElement)) {
      throw new Error("Expected the edit canvas image to be an image element");
    }
    expect(image.style.opacity).toBe("0");
    mockImageNaturalSize(image, { height: 900, width: 1200 });
    fireEvent.load(image);

    await waitFor(() => {
      expect(image).toHaveStyle({ height: "252px", width: "336px" });
    });
    expect(image.style.opacity).toBe("");
  });

  it("fits restored edit canvas items into the viewport", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
      persistedImageEditSnapshot: {
        items: [
          { url: SOURCE_IMAGE_URL, x: 0, y: 0, zIndex: 1 },
          { url: EDITED_IMAGE_URL, x: 1200, y: 900, zIndex: 2 },
        ],
        version: 1,
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
        "alt",
        "source.png",
      );
    });

    await user.click(screen.getByTestId("artifact-sidebar-edit-image"));
    const canvas = await screen.findByTestId(
      "artifact-sidebar-image-edit-canvas",
    );
    mockElementClientSize(canvas, { height: 500, width: 500 });

    const transformWrapper = canvas.querySelector<HTMLElement>(
      ".react-transform-wrapper",
    );
    const transformContent = canvas.querySelector<HTMLElement>(
      ".react-transform-component",
    );
    const surface = screen.getByTestId(
      "artifact-sidebar-image-edit-canvas-surface",
    );
    if (transformWrapper === null || transformContent === null) {
      throw new Error("Expected edit canvas transform elements");
    }
    mockElementLayoutBox(transformWrapper, { height: 500, width: 500 });
    mockElementLayoutBox(transformContent, {
      height: 1200,
      width: 1600,
    });
    mockElementLayoutBox(surface, {
      height: 1200,
      left: 64,
      top: 64,
      width: 1600,
    });

    const sourceImage = screen.getByTestId("artifact-sidebar-body-image");
    const restoredImage = await screen.findByTestId(
      "artifact-sidebar-body-image-copy",
    );
    if (
      !(sourceImage instanceof HTMLImageElement) ||
      !(restoredImage instanceof HTMLImageElement)
    ) {
      throw new Error("Expected restored canvas items to be image elements");
    }
    mockImageNaturalSize(sourceImage, { height: 900, width: 1200 });
    mockImageNaturalSize(restoredImage, { height: 900, width: 1200 });
    fireEvent.load(sourceImage);
    fireEvent.load(restoredImage);

    const expectedScale = Number.parseFloat((452 / 1652).toFixed(8));
    const expectedX = 250 - (64 + 826) * expectedScale;
    const expectedY = 250 - (64 + 619.5) * expectedScale;
    await waitFor(() => {
      expect(transformContent.style.transform).toContain(
        `scale(${expectedScale})`,
      );
    });
    const [x, y, scale] = transformNumbers(transformContent.style.transform);
    expect(x).toBeCloseTo(expectedX, 4);
    expect(y).toBeCloseTo(expectedY, 4);
    expect(scale).toBeCloseTo(expectedScale, 8);
  });

  it("refits edit canvas item dimensions after entering fullscreen", async () => {
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

    await user.click(screen.getByTestId("artifact-sidebar-edit-image"));
    const sidebarCanvas = await screen.findByTestId(
      "artifact-sidebar-image-edit-canvas",
    );
    mockElementClientSize(sidebarCanvas, { height: 300, width: 400 });
    const sidebarImage = screen.getByTestId("artifact-sidebar-body-image");
    if (!(sidebarImage instanceof HTMLImageElement)) {
      throw new Error("Expected sidebar edit canvas item to be an image");
    }
    mockImageNaturalSize(sidebarImage, { height: 900, width: 1200 });
    fireEvent.load(sidebarImage);
    await waitFor(() => {
      expect(sidebarImage).toHaveStyle({ height: "252px", width: "336px" });
    });

    await user.click(screen.getByTestId("artifact-sidebar-fullscreen-toggle"));
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-fullscreen-toggle"),
      ).toHaveAttribute("aria-label", "Exit fullscreen");
    });

    const fullscreenCanvas = screen.getByTestId(
      "artifact-sidebar-image-edit-canvas",
    );
    mockElementClientSize(fullscreenCanvas, { height: 900, width: 1200 });
    const transformWrapper = fullscreenCanvas.querySelector<HTMLElement>(
      ".react-transform-wrapper",
    );
    const transformContent = fullscreenCanvas.querySelector<HTMLElement>(
      ".react-transform-component",
    );
    const surface = screen.getByTestId(
      "artifact-sidebar-image-edit-canvas-surface",
    );
    if (transformWrapper === null || transformContent === null) {
      throw new Error("Expected fullscreen edit canvas transform elements");
    }
    mockElementLayoutBox(transformWrapper, { height: 900, width: 1200 });
    mockElementLayoutBox(transformContent, {
      height: 1200,
      width: 1600,
    });
    mockElementLayoutBox(surface, {
      height: 1200,
      left: 64,
      top: 64,
      width: 1600,
    });

    const fullscreenImage = screen.getByTestId("artifact-sidebar-body-image");
    if (!(fullscreenImage instanceof HTMLImageElement)) {
      throw new Error("Expected fullscreen edit canvas item to be an image");
    }
    expect(fullscreenImage.style.opacity).toBe("0");
    mockImageNaturalSize(fullscreenImage, { height: 900, width: 1200 });
    fireEvent.load(fullscreenImage);

    await waitFor(() => {
      expect(fullscreenImage).toHaveStyle({
        height: "852px",
        width: "1136px",
      });
    });
    expect(fullscreenImage.style.opacity).toBe("");
    await waitFor(() => {
      expect(transformContent.style.transform).toContain("scale(1)");
    });
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
    expect(screen.queryByTestId("artifact-sidebar-edit-image")).toBeNull();

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
    expect(screen.getByTestId("artifact-sidebar")).toHaveClass("z-[9999]");
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
    expect(screen.getByTestId("artifact-sidebar")).toHaveClass("z-[9999]");
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

    await exitAndReopenImageEditMode(user);
    const restoredImage = screen.getByTestId("artifact-sidebar-body-image");
    expect(restoredImage).toHaveStyle({ left: "470px", top: "370px" });
    await user.click(restoredImage);
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });

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

  it("keeps the selected image edit toolbar above higher canvas image layers", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);

    const canvas = screen.getByTestId("artifact-sidebar-image-edit-canvas");
    const sourceImage = screen.getByTestId("artifact-sidebar-body-image");
    fireEvent.keyDown(canvas, { key: "c", metaKey: true });
    fireEvent.keyDown(canvas, { key: "v", metaKey: true });

    const copiedImage = await screen.findByTestId(
      "artifact-sidebar-body-image-copy",
    );
    await user.click(sourceImage);

    const toolbarLayer = screen
      .getByTestId("image-edit-toolbar")
      .closest(".image-edit-floating-toolbar");
    if (!(toolbarLayer instanceof HTMLElement)) {
      throw new Error("Missing image edit toolbar layer");
    }

    const toolbarZIndex = Number(toolbarLayer.style.zIndex);
    const sourceImageZIndex = Number(sourceImage.style.zIndex);
    const copiedImageZIndex = Number(copiedImage.style.zIndex);

    expect(sourceImageZIndex).toBeLessThan(copiedImageZIndex);
    expect(toolbarZIndex).toBeGreaterThan(copiedImageZIndex);
  });

  it("deletes the selected image with the Delete or Backspace key", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatThread({
      featureSwitches: { [FeatureSwitchKey.ImageEditing]: true },
    });

    await openSelectedImageEditToolbar(user);
    const canvas = screen.getByTestId("artifact-sidebar-image-edit-canvas");

    // Duplicate the source, then remove the copy with Backspace.
    fireEvent.keyDown(canvas, { key: "c", metaKey: true });
    fireEvent.keyDown(canvas, { key: "v", metaKey: true });
    await waitFor(() => {
      expect(
        screen.getByTestId("artifact-sidebar-body-image-copy"),
      ).toBeInTheDocument();
    });

    fireEvent.keyDown(canvas, { key: "Backspace" });
    await waitFor(() => {
      expect(
        screen.queryByTestId("artifact-sidebar-body-image-copy"),
      ).toBeNull();
    });
    expect(
      screen.getByTestId("artifact-sidebar-body-image"),
    ).toBeInTheDocument();

    // Select the source itself, then remove it with Delete.
    await user.click(screen.getByTestId("artifact-sidebar-body-image"));
    await waitFor(() => {
      expect(screen.getByTestId("image-edit-toolbar")).toBeInTheDocument();
    });

    fireEvent.keyDown(canvas, { key: "Delete" });
    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar-body-image")).toBeNull();
    });
    expect(screen.queryByTestId("image-edit-toolbar")).toBeNull();
  });
});
