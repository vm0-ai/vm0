import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
  r2ImageTransformUrl,
} from "@okouai/core";
import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  presentationTemplatesContract,
  PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
  type PresentationTemplateCatalogEntry,
  type PresentationTemplateDetail,
  type PresentationTemplatePreviewAsset,
  type PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";
import {
  avatarVideoContract,
  type AvatarVideoAvatarsQuery,
  type AvatarVideoVoice,
  type AvatarVideoVoicesQuery,
} from "@okouai/api-contracts/contracts/avatar-video";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { avatarTemplateStylePresetId } from "@okouai/core/avatar-template";
import { setMockPresentationTemplates } from "../../../mocks/handlers/api-presentation-templates.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { now } from "../../../lib/time.ts";
import {
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";
import {
  context,
  AGENT_ID,
  THREAD_ID,
  SUGGESTED_THREAD_ID,
  linkByText,
  tabByText,
  presentationTemplateGridScrollContainer,
  mockActiveTemplateThread,
  mockAgent,
  mockOrgModelRoutes,
  trackTemplatePreviewImagePreloads,
  mockImmediateIdleCallback,
  mockUrlObjectMethods,
  selectTemplate,
  selectIllustrationTemplate,
  composerElementFrom,
  findComposerEditor,
  expectInlineTemplateInComposer,
  composerInlineTemplates,
  appendAndSend,
  billingStatus,
} from "./chat-composer-test-helpers.ts";

// Templates are sent as inline parts of the structured userMessage.
function sentInlineTemplate(
  userMessage: UserMessageDocument | undefined,
): GenerationTemplateRequest | undefined {
  for (const part of userMessage?.parts ?? []) {
    if (part.type === "template") {
      return part.template;
    }
  }
  return undefined;
}

function activeImportedTemplateImage(media: HTMLElement): HTMLImageElement {
  const image = media.querySelector(
    '[data-imported-presentation-template-image][data-active="true"]',
  );
  if (!(image instanceof HTMLImageElement)) {
    throw new Error("Active imported template image not found");
  }
  return image;
}

async function requestedImportedTemplateImage(
  media: HTMLElement,
  url: string,
): Promise<HTMLImageElement> {
  return await waitFor(() => {
    const found = Array.from(
      media.querySelectorAll<HTMLImageElement>(
        "[data-imported-presentation-template-image]",
      ),
    ).find((candidate) => {
      return candidate.getAttribute("src") === url;
    });
    if (found === undefined) {
      throw new Error(`Imported template image was not requested: ${url}`);
    }
    return found;
  });
}

async function loadImportedTemplateImage(
  media: HTMLElement,
  url: string,
): Promise<HTMLImageElement> {
  const image = await requestedImportedTemplateImage(media, url);
  fireEvent.load(image);
  await waitFor(() => {
    expect(image).toHaveAttribute("data-loaded-image-url", url);
  });
  return image;
}

type TestPresentationTemplateDetail = Omit<
  PresentationTemplateDetail,
  "previewAssets"
> & {
  readonly previewAssets?: readonly PresentationTemplatePreviewAsset[];
};

function presentationTemplateDetail(
  template: TestPresentationTemplateDetail,
): PresentationTemplateDetail {
  return {
    ...template,
    previewAssets:
      template.previewAssets === undefined
        ? template.pageUrls.map((url, index) => {
            return {
              previewAssetId: `ptp:${template.id}:test-${index.toString()}`,
              url,
              expiresAt: new Date(
                now() + PRESENTATION_TEMPLATE_URL_TTL_SECONDS * 1000,
              ).toISOString(),
            };
          })
        : [...template.previewAssets],
  };
}

function presentationTemplateSummary(
  template: TestPresentationTemplateDetail,
): PresentationTemplateSummary {
  const {
    pageUrls: _pageUrls,
    previewAssets: _previewAssets,
    ...summary
  } = template;
  return summary;
}

function presentationTemplateCatalogEntry(
  template: TestPresentationTemplateDetail,
): PresentationTemplateCatalogEntry {
  const { pageUrls: _pageUrls, ...entry } =
    presentationTemplateDetail(template);
  return entry;
}

function createAvatarFirstPage() {
  return Array.from({ length: 24 }, (_, index) => {
    const id = index + 1;
    return {
      id,
      name: `Avatar ${String(id)}`,
      videoUrl: `https://example.com/avatar-${String(id)}.${index === 1 ? "jpg" : "mp4"}`,
      coverUrl: `https://example.com/avatar-${String(id)}.jpg`,
      aspectRatio: 0,
    };
  });
}

function createSelectedAvatar() {
  return {
    id: 81,
    name: "Ada",
    videoUrl: "https://example.com/ada.mp4",
    coverUrl: "https://example.com/ada.jpg",
    aspectRatio: 0,
    style: "professional",
    gender: "male",
    age: "young_adult",
  };
}

function createSelectedVoice(): AvatarVideoVoice {
  return {
    id: "en-US-ChristopherNeural",
    name: "Christopher",
    sampleUrl: "https://example.com/christopher.mp3",
    language: "English",
    gender: "male",
    age: "young",
    accent: "american",
    useCase: "advertisement",
  };
}

function createAlternateVoice() {
  return {
    id: "es-ES-AlvaroNeural",
    name: "Alvaro",
    sampleUrl: "https://example.com/alvaro.mp3",
    language: "Spanish",
    gender: "male",
    age: "young",
    accent: "british",
    useCase: "advertisement",
  };
}

function createSecondVoice() {
  return {
    id: "en-US-AvaNeural",
    name: "Ava",
    sampleUrl: "https://example.com/ava.mp3",
    language: "English",
    gender: "female",
    age: "young",
    accent: "american",
    useCase: "advertisement",
  };
}

type TestDeferred = ReturnType<typeof context.mocks.deferred<void>>;

function mockAvatarCatalog({
  observedQueries = [],
  firstPage = createAvatarFirstPage(),
  filterReady,
  pageTwoReady,
}: {
  readonly observedQueries?: AvatarVideoAvatarsQuery[];
  readonly firstPage?: ReturnType<typeof createAvatarFirstPage>;
  readonly filterReady?: TestDeferred;
  readonly pageTwoReady?: TestDeferred;
} = {}): void {
  const selectedAvatar = createSelectedAvatar();
  context.mocks.api(avatarVideoContract.avatars, async ({ query, respond }) => {
    observedQueries.push(query);
    if (
      filterReady &&
      query.page === 1 &&
      query.style === "professional" &&
      query.scene === "business" &&
      query.ethnicity === "north_american"
    ) {
      await filterReady.promise;
    }
    if (pageTwoReady && query.page === 2) {
      await pageTwoReady.promise;
    }
    return respond(200, {
      avatars: query.page === 2 ? [selectedAvatar] : firstPage,
    });
  });
}

function mockVoiceCatalog({
  observedQueries = [],
  filterReady,
  pageTwoReady,
  selectedVoice = createSelectedVoice(),
}: {
  readonly observedQueries?: AvatarVideoVoicesQuery[];
  readonly filterReady?: TestDeferred;
  readonly pageTwoReady?: TestDeferred;
  readonly selectedVoice?: AvatarVideoVoice;
} = {}): void {
  const alternateVoice = createAlternateVoice();
  const secondVoice = createSecondVoice();
  context.mocks.api(avatarVideoContract.voices, async ({ query, respond }) => {
    observedQueries.push(query);
    if (
      filterReady &&
      query.pageSize === 24 &&
      query.page === 1 &&
      query.language === "spanish"
    ) {
      await filterReady.promise;
    }
    if (pageTwoReady && query.pageSize === 24 && query.page === 2) {
      await pageTwoReady.promise;
    }
    const loadingFilterOptions =
      query.pageSize === 100 &&
      query.language === undefined &&
      query.gender === undefined &&
      query.age === undefined &&
      query.useCase === undefined;
    const loadingRecommendation =
      query.pageSize === 100 && query.language !== undefined;
    const voices = loadingFilterOptions
      ? [alternateVoice, selectedVoice]
      : loadingRecommendation
        ? [alternateVoice, selectedVoice]
        : query.page === 2
          ? [secondVoice]
          : query.language === "english"
            ? [selectedVoice]
            : [alternateVoice, selectedVoice];
    return respond(200, {
      voices,
      hasMore:
        query.page === 1 && (query.pageSize === 24 || loadingFilterOptions),
      filterOptions: loadingFilterOptions
        ? {
            languages: ["english", "spanish"],
            useCases: ["advertisement", "narrative_story", "social_media"],
          }
        : {
            languages: ["english"],
            useCases: ["narrative_story"],
          },
    });
  });
}

async function openAvatarPicker(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  await user.click(
    await waitFor(() => {
      return screen.getByLabelText("Template");
    }),
  );
  await user.click(
    await waitFor(() => {
      return tabByText("Avatar");
    }),
  );

  return screen.getByRole("dialog");
}

async function selectAvatarRecommendationFilters(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
): Promise<void> {
  await user.click(within(dialog).getByText("Filters"));
  await user.click(screen.getByLabelText("Style: All"));
  await user.click(await screen.findByRole("option", { name: "Professional" }));
  await user.click(screen.getByLabelText("Scene: All"));
  await user.click(await screen.findByRole("option", { name: "Business" }));
  await user.click(screen.getByLabelText("Ethnicity: All"));
  await user.click(
    await screen.findByRole("option", { name: "North american" }),
  );
  await user.keyboard("{Escape}");
}

// Serves the deck the detail preview renders into its slide shadow roots. The
// inline stylesheet gives every slide a fixed size so the preview scales it the
// same way it scales a real deck.
function mockStyledPresentationDeck(
  template: (typeof PRESENTATION_TEMPLATE_PICKER_ITEMS)[number],
): void {
  context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
    return new Response(
      `<!doctype html><html><head><style>:root { --bg: white; --ink: black; } section { width: 1600px; height: 900px; background: var(--bg); color: var(--ink); }</style></head><body>${template.previewImages
        .map((_, index) => {
          return `<section data-vm0-slide data-slide-id="slide-${index + 1}"><h1>Slide ${index + 1}</h1></section>`;
        })
        .join("")}</body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  });
}

// Opens the picker and the template's detail preview from its card. Returns the
// dialog, which stays mounted across the picker/detail transition.
async function openPresentationDetailPreview(
  template: (typeof PRESENTATION_TEMPLATE_PICKER_ITEMS)[number],
): Promise<HTMLElement> {
  click(
    await waitFor(() => {
      return screen.getByLabelText("Template");
    }),
  );
  click(screen.getByLabelText(`Preview ${template.title} at current slide`));
  return screen.getByRole("dialog");
}

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus("pro"));
  });
  context.mocks.http.get("*/__vm0-dev-artifact-fetch", ({ request }) => {
    const requestedUrl = new URL(request.url).searchParams.get("url");
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.embedUrl === requestedUrl;
    });
    const slideCount = Math.max(
      template?.slideCount ?? template?.previewImages.length ?? 1,
      1,
    );
    return new Response(
      `<!doctype html><html><body>${Array.from(
        { length: slideCount },
        (_, index) => {
          return `<section data-vm0-slide data-slide-id="slide-${String(index + 1)}"><h1>Slide ${String(index + 1)}</h1></section>`;
        },
      ).join("")}</body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  });
});

describe("chat composer templates", () => {
  // Whichever test renders the chat page first pays a one-time cost for
  // evaluating the chat-page module graph and for React's first render of it
  // (~900ms in CI). That cost lands inside the first test's 5000ms budget, so
  // this file opens with its cheapest page-rendering assertion. Keep it first:
  // putting a long interaction sequence here stacks the one-time cost on top of
  // the sequence and leaves the test without margin on a contended runner.
  it("places the template control immediately after the legacy attach button by default", async () => {
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );

    await waitFor(() => {
      const controls = Array.from(
        composer.querySelectorAll(
          [
            'button[aria-label="Attach"]',
            'button[aria-label="Template"]',
            'button[aria-label="Connectors"]',
          ].join(","),
        ),
      ).map((button) => {
        return button.getAttribute("aria-label");
      });

      expect(controls).toStrictEqual(["Attach", "Template", "Connectors"]);
      expect(
        composer.querySelector('button[aria-label="Upload"]'),
      ).not.toBeInTheDocument();
    });
  });

  it("inserts multiple inline templates and sends a template-only message", async () => {
    const user = userEvent.setup({ delay: null });
    const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const second = PRESENTATION_TEMPLATE_PICKER_ITEMS[1]!;
    let submittedUserMessage: UserMessageDocument | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        submittedUserMessage = body.userMessage;
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    for (const template of [first, second]) {
      click(
        await waitFor(() => {
          return screen.getByLabelText("Template");
        }),
      );
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
      await user.click(
        screen.getByLabelText(`Select template ${template.title}`),
      );
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    }

    const templateChips = document.querySelectorAll(
      "[data-composer-inline-template]",
    );
    expect(templateChips).toHaveLength(2);
    for (const chip of templateChips) {
      expect(chip.querySelector("img")).not.toBeInTheDocument();
      expect(chip.querySelector("svg")).toBeInTheDocument();
      expect(chip).toHaveClass(
        "-top-px",
        "bg-orange-500/10",
        "text-orange-600",
      );
      // Hover lives on the zones so each half of a split chip reacts alone.
      expect(chip.querySelector("button")).toHaveClass(
        "hover:bg-orange-500/15",
      );
      expect(
        chip.querySelector('button[aria-label^="Remove template"]'),
      ).not.toBeInTheDocument();
    }
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeEnabled();
    });
    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(submittedUserMessage?.parts).toHaveLength(2);
      expect(submittedUserMessage?.parts[0]).toMatchObject({
        type: "template",
        titleSnapshot: first.title,
        template: {
          type: "presentation",
          selection: { templateId: first.templateId },
        },
      });
      expect(submittedUserMessage?.parts[1]).toMatchObject({
        type: "template",
        titleSnapshot: second.title,
        template: {
          type: "presentation",
          selection: { templateId: second.templateId },
        },
      });
    });
  });

  it("sends a video template without any run parameters on it", async () => {
    const user = userEvent.setup({ delay: null });
    const template = VIDEO_TEMPLATE_ITEMS[0]!;
    let submittedUserMessage: UserMessageDocument | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        submittedUserMessage = body.userMessage;
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    await user.click(tabByText("Video"));

    // The model belongs to the run now, so the picker offers no model row.
    expect(
      screen.queryByLabelText("Video model Seedance 2.0 fast"),
    ).not.toBeInTheDocument();

    await user.click(
      await screen.findByLabelText(`Select video template ${template.title}`),
    );

    // One zone: the template name. Parameters moved to the composer's own
    // settings chip, so the inline chip no longer splits in two.
    const chip = await waitFor(() => {
      const found = document.querySelector("[data-composer-inline-template]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(chip.querySelectorAll("button")).toHaveLength(1);

    await user.click(screen.getByLabelText("Send"));
    await waitFor(() => {
      expect(submittedUserMessage?.parts[0]).toMatchObject({
        type: "template",
        template: {
          type: "video",
          selection: { stylePresetId: template.id },
        },
      });
    });
    expect(sentInlineTemplate(submittedUserMessage)).toStrictEqual({
      type: "video",
      selection: { stylePresetId: template.id },
    });
  });

  it("leaves every video parameter to the composer in video mode", async () => {
    const user = userEvent.setup({ delay: null });
    const template = VIDEO_TEMPLATE_ITEMS[0]!;
    let submittedTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        submittedTemplate = sentInlineTemplate(body.userMessage);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await user.click(tabByText("Video"));

    expect(
      screen.queryByLabelText("Video model Seedance 2.0 fast"),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByLabelText(`Select video template ${template.title}`),
    );

    // The chip is the template name and nothing else: ratio, duration,
    // resolution and audio are set from the composer's own settings chip, so
    // there is no second zone here and nothing to write onto the selection.
    const chip = await waitFor(() => {
      const found = document.querySelector("[data-composer-inline-template]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(chip.querySelectorAll("button")).toHaveLength(1);
    expect(screen.queryByLabelText(/^Video options /)).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(submittedTemplate).toStrictEqual({
        type: "video",
        selection: { stylePresetId: template.id },
      });
    });
  });

  it("replaces a selected inline template instead of inserting another", async () => {
    const user = userEvent.setup({ delay: null });
    const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const replacement = PRESENTATION_TEMPLATE_PICKER_ITEMS[1]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await user.click(
      await screen.findByLabelText(`Select template ${first.title}`),
    );
    await user.click(
      await screen.findByLabelText(`Preview template ${first.title}`),
    );
    const selectedChip = document.querySelector(
      "[data-composer-inline-template]",
    );
    expect(selectedChip).toHaveAttribute("data-selected", "");
    expect(selectedChip).toHaveStyle({
      outline: "none",
      userSelect: "none",
    });
    expect(selectedChip).toHaveClass(
      "select-none",
      "data-[selected]:bg-orange-500/15",
      "data-[selected]:ring-orange-500/40",
    );
    expect(
      screen.getByLabelText(`Preview template ${first.title}`),
    ).toHaveClass("text-orange-600");
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(
      screen.getByLabelText(`Select template ${first.title}`),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(
      screen.getByLabelText(`Select template ${replacement.title}`),
    );

    await waitFor(() => {
      expect(
        document.querySelectorAll("[data-composer-inline-template]"),
      ).toHaveLength(1);
      expect(
        screen.queryByLabelText(`Preview template ${first.title}`),
      ).not.toBeInTheDocument();
      expect(
        screen.getByLabelText(`Preview template ${replacement.title}`),
      ).toBeInTheDocument();
    });
  });

  it("prewarms template previews only after the template button is used", async () => {
    const imagePreloads = trackTemplatePreviewImagePreloads();
    mockImmediateIdleCallback();
    const templatePreviewSrcs = () => {
      return imagePreloads.srcs.filter((src) => {
        return src.includes("/cdn-cgi/image/width=480,height=270");
      });
    };

    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const templateButton = await waitFor(() => {
      return screen.getByLabelText("Template");
    });

    expect(templatePreviewSrcs()).toStrictEqual([]);

    click(templateButton);

    await waitFor(() => {
      expect(templatePreviewSrcs().length).toBeGreaterThan(0);
    });
  });

  it("loads the presentation preview at low resolution before replacing it with the high-resolution image", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );

    const lowResolutionImage = await screen.findByTestId(
      `${template.title} card image preview`,
    );
    const highResolutionImage = lowResolutionImage.parentElement?.querySelector(
      '[data-template-preview-image="high"]',
    );
    if (!(highResolutionImage instanceof HTMLImageElement)) {
      throw new Error("High-resolution presentation preview image not found");
    }

    expect(lowResolutionImage).toHaveAttribute(
      "src",
      expect.stringContaining("width=480,height=270"),
    );
    expect(highResolutionImage).not.toHaveAttribute("src");
    expect(highResolutionImage).toHaveAttribute(
      "data-src",
      expect.stringContaining("width=708,height=398"),
    );
    if (template.cardPreviewImage === undefined) {
      throw new Error("Presentation card preview image not found");
    }
    expect(highResolutionImage).toHaveAttribute(
      "data-src",
      r2ImageTransformUrl(template.cardPreviewImage, {
        width: 708,
        height: 398,
      }),
    );

    fireEvent.load(lowResolutionImage);
    expect(highResolutionImage).toHaveAttribute(
      "src",
      highResolutionImage.dataset.src,
    );
    expect(lowResolutionImage).not.toHaveAttribute("data-replaced");

    fireEvent.load(highResolutionImage);
    await waitFor(() => {
      expect(highResolutionImage).toHaveAttribute("data-loaded", "true");
      expect(lowResolutionImage).not.toHaveAttribute("data-replaced");
    });
  });

  it("opens the template picker with responsive category navigation", async () => {
    const user = userEvent.setup({ delay: null });
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const videoTemplate = VIDEO_TEMPLATE_ITEMS[0]!;
    mockAvatarCatalog();
    mockVoiceCatalog();
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const templateButton = await waitFor(() => {
      return screen.getByLabelText("Template");
    });
    expect(templateButton.querySelector("img")).toBeNull();
    expect(templateButton.querySelector("svg")).toBeInTheDocument();

    click(templateButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Search templates")).not.toBeInTheDocument();

    expect(tabByText("Presentation")).toBeInTheDocument();
    expect(tabByText("Illustration")).toBeInTheDocument();
    expect(tabByText("Video")).toBeInTheDocument();
    expect(tabByText("Website")).toBeInTheDocument();
    expect(tabByText("Avatar")).toBeInTheDocument();
    expect(document.activeElement).not.toBe(tabByText("Presentation"));
    expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
    const categorySelect = screen.getByRole("combobox", {
      name: "Template category",
    });
    expect(categorySelect).toBeInTheDocument();

    const categorySidebar = screen.getByRole("tablist", {
      name: "Template categories",
    });
    expect(categorySidebar).toBeInstanceOf(HTMLElement);
    expect(categorySidebar).toHaveAttribute("aria-orientation", "vertical");

    await user.click(categorySelect);
    await user.click(
      await screen.findByRole("option", { name: "Illustration" }),
    );

    await waitFor(() => {
      expect(categorySelect).toHaveTextContent("Illustration");
      expect(tabByText("Illustration")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByText(illustrationTemplate.title)).toBeInTheDocument();
    });

    tabByText("Illustration").focus();
    fireEvent.keyDown(tabByText("Illustration"), { key: "ArrowDown" });
    await waitFor(() => {
      expect(tabByText("Video")).toHaveFocus();
      expect(tabByText("Video")).toHaveAttribute("aria-selected", "true");
      expect(
        screen.getByLabelText(`Select video template ${videoTemplate.title}`),
      ).toBeInTheDocument();
    });

    fireEvent.keyDown(tabByText("Video"), { key: "ArrowUp" });
    await waitFor(() => {
      expect(tabByText("Illustration")).toHaveFocus();
      expect(tabByText("Illustration")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    fireEvent.keyDown(tabByText("Illustration"), { key: "End" });
    await waitFor(() => {
      expect(tabByText("Workflow")).toHaveFocus();
      expect(tabByText("Workflow")).toHaveAttribute("aria-selected", "true");
      expect(screen.getByLabelText("Search templates")).toBeInTheDocument();
    });

    fireEvent.keyDown(tabByText("Workflow"), { key: "Home" });
    await waitFor(() => {
      expect(tabByText("Presentation")).toHaveFocus();
      expect(tabByText("Presentation")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("previews, filters, paginates, and selects avatars", async () => {
    const user = userEvent.setup({ delay: null });
    const avatarFirstPage = createAvatarFirstPage();
    const selectedAvatar = createSelectedAvatar();
    const observedQueries: AvatarVideoAvatarsQuery[] = [];
    const avatarFilterReady = context.mocks.deferred<void>();
    const avatarPageTwoReady = context.mocks.deferred<void>();
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    mockAvatarCatalog({
      observedQueries,
      firstPage: avatarFirstPage,
      filterReady: avatarFilterReady,
      pageTwoReady: avatarPageTwoReady,
    });
    mockVoiceCatalog();
    mockChatLifecycle(context, { threadId: THREAD_ID });

    const dialog = await openAvatarPicker(user);
    await within(dialog).findByLabelText("Select template Avatar 1");
    await user.click(within(dialog).getByLabelText("Aspect ratio: 16:9"));
    await waitFor(() => {
      expect(observedQueries).toContainEqual({
        page: 1,
        pageSize: 24,
        aspectRatio: "landscape",
      });
    });
    await selectAvatarRecommendationFilters(user, dialog);
    await waitFor(() => {
      expect(
        dialog.querySelector("[data-avatar-template-skeleton-grid]"),
      ).toBeInTheDocument();
    });
    avatarFilterReady.resolve();
    await waitFor(() => {
      expect(observedQueries).toContainEqual({
        page: 1,
        pageSize: 24,
        aspectRatio: "landscape",
        style: "professional",
        scene: "business",
        ethnicity: "north_american",
      });
    });
    const firstCard = within(dialog).getByLabelText("Select template Avatar 1");
    const firstPreview = firstCard.querySelector(
      "[data-avatar-template-preview]",
    );
    if (!(firstPreview instanceof HTMLElement)) {
      throw new Error("Avatar preview not found");
    }
    const firstVideo = firstPreview.querySelector("video");
    if (!(firstVideo instanceof HTMLVideoElement)) {
      throw new Error("Avatar preview video not found");
    }
    expect(firstPreview).toHaveClass("aspect-video");
    expect(firstVideo).toHaveAttribute("preload", "none");
    expect(firstVideo).toHaveAttribute("poster", avatarFirstPage[0]?.coverUrl);
    expect(firstVideo).toHaveAttribute("src", avatarFirstPage[0]?.videoUrl);
    fireEvent.mouseEnter(firstCard);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(firstVideo.preload).toBe("metadata");
    firstVideo.currentTime = 3;
    fireEvent.mouseLeave(firstCard);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(firstVideo.currentTime).toBe(0);
    const imageOnlyPreview = within(dialog)
      .getByAltText("Avatar 2")
      .closest("[data-avatar-template-preview]");
    expect(imageOnlyPreview).not.toBeNull();
    expect(imageOnlyPreview?.querySelector("video")).toBeNull();

    expect(
      within(dialog).queryByLabelText("Next page"),
    ).not.toBeInTheDocument();
    const avatarScroll = dialog.querySelector(
      "[data-avatar-template-grid-scroll]",
    );
    if (!(avatarScroll instanceof HTMLElement)) {
      throw new Error("Avatar catalog scroll area not found");
    }
    expect(avatarScroll).toHaveClass(
      "overflow-y-auto",
      "[scrollbar-width:none]",
    );
    // The toolbar lives in the dialog header row next to the close button,
    // so it must not sit inside the scrolling catalog area.
    expect(
      avatarScroll.querySelector("[data-avatar-catalog-toolbar]"),
    ).toBeNull();
    expect(
      dialog.querySelector("[data-avatar-catalog-toolbar]"),
    ).not.toBeNull();
    Object.defineProperties(avatarScroll, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 500 },
    });
    fireEvent.scroll(avatarScroll);
    await within(dialog).findByText("Loading");
    avatarPageTwoReady.resolve();
    const selectAvatar = await within(dialog).findByLabelText(
      "Select template Ada",
    );
    expect(within(dialog).getByLabelText("Select template Avatar 1")).toBe(
      firstCard,
    );
    expect(avatarScroll.scrollTop).toBe(500);
    const adaPreview = selectAvatar.querySelector(
      "[data-avatar-template-preview]",
    );
    expect(adaPreview?.querySelector("video")).toHaveAttribute(
      "poster",
      selectedAvatar.coverUrl,
    );
    await user.click(selectAvatar);

    await within(dialog).findByText("Choose a voice for Ada");
    await expect(
      within(dialog).findByLabelText("Preview avatar video Ada"),
    ).resolves.toBeInTheDocument();
    expect(observedQueries).toStrictEqual([
      { page: 1, pageSize: 24, aspectRatio: "portrait" },
      { page: 1, pageSize: 24, aspectRatio: "landscape" },
      {
        page: 1,
        pageSize: 24,
        aspectRatio: "landscape",
        style: "professional",
      },
      {
        page: 1,
        pageSize: 24,
        aspectRatio: "landscape",
        style: "professional",
        scene: "business",
      },
      {
        page: 1,
        pageSize: 24,
        aspectRatio: "landscape",
        style: "professional",
        scene: "business",
        ethnicity: "north_american",
      },
      {
        page: 2,
        pageSize: 24,
        aspectRatio: "landscape",
        style: "professional",
        scene: "business",
        ethnicity: "north_american",
      },
    ]);
  });

  it("shows a tooltip for an unavailable voice preview", async () => {
    const user = userEvent.setup({ delay: null });
    const selectedAvatar = createSelectedAvatar();
    const unavailableVoice: AvatarVideoVoice = {
      ...createSelectedVoice(),
      sampleUrl: undefined,
    };
    mockAvatarCatalog({ firstPage: [selectedAvatar] });
    mockVoiceCatalog({ selectedVoice: unavailableVoice });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    const dialog = await openAvatarPicker(user);
    await selectAvatarRecommendationFilters(user, dialog);
    await user.click(
      await within(dialog).findByLabelText("Select template Ada"),
    );

    const previewButton = await within(dialog).findByLabelText(
      "Preview voice Christopher",
    );
    expect(previewButton).toBeDisabled();
    expect(previewButton).not.toHaveAttribute("title");
    const trigger = previewButton.closest<HTMLElement>(
      '[data-slot="tooltip-trigger"]',
    );
    if (trigger === null) {
      throw new Error("Unavailable voice tooltip trigger not found");
    }
    await user.hover(trigger);

    await expect(
      screen.findByText("Preview voice Christopher"),
    ).resolves.toBeVisible();
  });

  it("recommends, previews, filters, and paginates avatar voices", async () => {
    const user = userEvent.setup({ delay: null });
    const selectedAvatar = createSelectedAvatar();
    const selectedVoice = createSelectedVoice();
    const observedVoiceQueries: AvatarVideoVoicesQuery[] = [];
    const voiceFilterReady = context.mocks.deferred<void>();
    const voicePageTwoReady = context.mocks.deferred<void>();
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    mockAvatarCatalog({ firstPage: [selectedAvatar] });
    mockVoiceCatalog({
      observedQueries: observedVoiceQueries,
      filterReady: voiceFilterReady,
      pageTwoReady: voicePageTwoReady,
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    const dialog = await openAvatarPicker(user);
    await selectAvatarRecommendationFilters(user, dialog);
    await user.click(
      await within(dialog).findByLabelText("Select template Ada"),
    );

    await within(dialog).findByText("Choose a voice for Ada");
    await expect(
      within(dialog).findByLabelText("Preview avatar video Ada"),
    ).resolves.toBeInTheDocument();
    const selectedAvatarCard = dialog.querySelector(
      "[data-selected-avatar-card]",
    );
    expect(selectedAvatarCard).toHaveClass("rounded-xl", "bg-card");
    expect(selectedAvatarCard).not.toHaveClass(
      "border-primary",
      "ring-primary",
    );
    const voicePicker = dialog.querySelector("[data-avatar-voice-picker]");
    const voiceScroll = dialog.querySelector("[data-avatar-voice-list-scroll]");
    const voiceToolbar = dialog.querySelector("[data-avatar-voice-toolbar]");
    expect(voicePicker).toHaveClass("overflow-hidden");
    expect(voiceScroll).toHaveClass(
      "overflow-y-auto",
      "[scrollbar-width:none]",
    );
    expect(voiceToolbar).not.toBeNull();
    expect(voicePicker?.contains(voiceToolbar)).toBeFalsy();
    expect(voiceScroll?.contains(voiceToolbar)).toBeFalsy();
    expect(dialog.querySelector("[data-avatar-catalog-toolbar]")).toBeNull();
    expect(voiceScroll?.contains(selectedAvatarCard)).toBeFalsy();
    await waitFor(() => {
      expect(observedVoiceQueries).toContainEqual({
        page: 1,
        pageSize: 24,
        language: "english",
        gender: "male",
        age: "young",
        useCase: "advertisement",
      });
    });
    const firstVoiceCard = await within(dialog).findByLabelText(
      "Select voice Christopher",
    );
    expect(voiceScroll?.querySelector("[data-avatar-voice-card]")).toBe(
      firstVoiceCard,
    );
    expect(firstVoiceCard).toHaveAttribute("data-recommended");
    expect(firstVoiceCard).toHaveAttribute("aria-pressed", "false");
    expect(firstVoiceCard).toHaveAccessibleDescription("Recommended");
    expect(within(firstVoiceCard).getByText("Recommended")).toBeVisible();
    const voiceFiltersButton = within(dialog).getByText("Filters", {
      selector: "button",
    });
    expect(voiceFiltersButton).not.toHaveClass(
      "border-primary/40",
      "text-primary",
    );
    await user.click(voiceFiltersButton);
    expect(screen.getByLabelText("Gender: Male")).toBeInTheDocument();
    expect(screen.getByLabelText("Age: Young")).toBeInTheDocument();
    expect(screen.getByLabelText("Language: English")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Use case: Advertisement"),
    ).toBeInTheDocument();
    await user.click(screen.getByLabelText("Language: English"));
    await user.click(await screen.findByRole("option", { name: "Spanish" }));
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        dialog.querySelector("[data-avatar-voice-skeleton-grid]"),
      ).toBeInTheDocument();
    });
    voiceFilterReady.resolve();
    await waitFor(() => {
      expect(observedVoiceQueries).toContainEqual({
        page: 1,
        pageSize: 24,
        language: "spanish",
        gender: "male",
        age: "young",
        useCase: "advertisement",
      });
    });
    const filteredFirstVoiceCard = await within(dialog).findByLabelText(
      "Select voice Christopher",
    );
    if (!(voiceScroll instanceof HTMLElement)) {
      throw new Error("Voice catalog scroll area not found");
    }
    Object.defineProperties(voiceScroll, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 500 },
    });
    fireEvent.scroll(voiceScroll);
    await within(dialog).findByText("Loading");
    voicePageTwoReady.resolve();
    await within(dialog).findByLabelText("Select voice Ava");
    expect(within(dialog).getByLabelText("Select voice Christopher")).toBe(
      filteredFirstVoiceCard,
    );
    expect(voiceScroll.scrollTop).toBe(500);
    const voicePreview = within(dialog).getByLabelText(
      "Preview voice Christopher",
    );
    const voiceCard = within(dialog).getByLabelText("Select voice Christopher");
    expect(voiceCard).not.toHaveClass("hover:-translate-y-px");
    const voiceAudio = voiceCard.querySelector("audio");
    expect(voiceAudio).toHaveAttribute("src", selectedVoice.sampleUrl);
    expect(voiceAudio).toHaveAttribute("preload", "none");
    expect(within(voiceCard).queryByText("Use")).not.toBeInTheDocument();
    const playCallsBeforeVoicePreview = playSpy.mock.calls.length;
    await user.click(voicePreview);
    expect(playSpy).toHaveBeenCalledTimes(playCallsBeforeVoicePreview + 1);
    expect(
      within(dialog).getByText("Choose a voice for Ada"),
    ).toBeInTheDocument();
    await user.click(voiceCard);

    await expectInlineTemplateInComposer("Ada");
    expect(observedVoiceQueries).toStrictEqual(
      expect.arrayContaining([
        { page: 1, pageSize: 100 },
        {
          page: 1,
          pageSize: 100,
          language: "english",
          gender: "male",
          age: "young",
          useCase: "advertisement",
        },
        {
          page: 1,
          pageSize: 100,
          language: "spanish",
          gender: "male",
          age: "young",
          useCase: "advertisement",
        },
        {
          page: 1,
          pageSize: 24,
          language: "english",
          gender: "male",
          age: "young",
          useCase: "advertisement",
        },
        {
          page: 1,
          pageSize: 24,
          language: "spanish",
          gender: "male",
          age: "young",
          useCase: "advertisement",
        },
        {
          page: 2,
          pageSize: 24,
          language: "spanish",
          gender: "male",
          age: "young",
          useCase: "advertisement",
        },
      ]),
    );
    expect(
      observedVoiceQueries.filter((query) => {
        return (
          query.pageSize === 100 &&
          query.language === undefined &&
          query.gender === undefined &&
          query.age === undefined &&
          query.useCase === undefined
        );
      }),
    ).toStrictEqual([{ page: 1, pageSize: 100 }]);
  });

  it("sends the selected avatar and voice", async () => {
    const user = userEvent.setup({ delay: null });
    const selectedAvatar = createSelectedAvatar();
    const selectedVoice = createSelectedVoice();
    const observedQueries: AvatarVideoAvatarsQuery[] = [];
    mockAvatarCatalog({
      observedQueries,
      firstPage: [selectedAvatar],
    });
    mockVoiceCatalog();
    let submittedTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        submittedTemplate = sentInlineTemplate(body.userMessage);
      },
    });

    const dialog = await openAvatarPicker(user);
    await within(dialog).findByLabelText("Select template Ada");
    await user.click(within(dialog).getByLabelText("Aspect ratio: 16:9"));
    await waitFor(() => {
      expect(observedQueries).toContainEqual({
        page: 1,
        pageSize: 24,
        aspectRatio: "landscape",
      });
    });
    await user.click(within(dialog).getByLabelText("Select template Ada"));
    await within(dialog).findByText("Choose a voice for Ada");
    await user.click(
      await within(dialog).findByLabelText("Select voice Christopher"),
    );

    await expectInlineTemplateInComposer("Ada");
    await appendAndSend(user, "Introduce our new product");

    await waitFor(() => {
      expect(submittedTemplate).toStrictEqual({
        type: "video",
        selection: {
          stylePresetId: avatarTemplateStylePresetId(selectedAvatar.id),
          avatarOptions: {
            titleSnapshot: selectedAvatar.name,
            previewUrl: selectedAvatar.coverUrl,
            voiceId: selectedVoice.id,
            aspectRatio: "landscape" as const,
          },
        },
      });
    });
  });

  it("keeps the chosen voice selected when the avatar picker reopens", async () => {
    const user = userEvent.setup({ delay: null });
    const selectedAvatar = createSelectedAvatar();
    const selectedVoice = createSelectedVoice();
    const alternateVoice = createAlternateVoice();
    mockAvatarCatalog({ firstPage: [selectedAvatar] });
    mockVoiceCatalog();
    mockChatLifecycle(context, { threadId: THREAD_ID });

    const dialog = await openAvatarPicker(user);
    await user.click(
      await within(dialog).findByLabelText("Select template Ada"),
    );
    await within(dialog).findByText("Choose a voice for Ada");
    await user.click(
      await within(dialog).findByLabelText(
        `Select voice ${selectedVoice.name}`,
      ),
    );
    await expectInlineTemplateInComposer("Ada");

    // Reopening from the inline chip hands the stored template back to the
    // picker, so the voice it carries must still read as the chosen one.
    await user.click(await screen.findByLabelText("Preview template Ada"));
    const reopened = await screen.findByRole("dialog");
    await user.click(
      await within(reopened).findByLabelText("Select template Ada"),
    );

    await waitFor(() => {
      expect(
        within(reopened).getByLabelText(`Select voice ${selectedVoice.name}`),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(
      within(reopened).getByLabelText(`Select voice ${alternateVoice.name}`),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("disables send while a template draft attachment is uploading", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });
    context.mocks.upload.pending({
      id: "upload-send-pending",
      filename: "launch-notes.txt",
      contentType: "text/plain",
      size: 16,
      url: "https://example.com/launch-notes.txt",
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await selectTemplate(user, template);
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }
    await user.upload(
      fileInput,
      new File(["pending notes"], "launch-notes.txt", {
        type: "text/plain",
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText("Cancel upload launch-notes.txt"),
      ).toBeInTheDocument();
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("Use this");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    expect(editor).toHaveTextContent("Use this");
    expect(
      screen.getByLabelText("Cancel upload launch-notes.txt"),
    ).toBeInTheDocument();
    expect(
      editor.querySelectorAll("[data-composer-inline-template]"),
    ).toHaveLength(1);
  });

  it("renders presentation template card hover previews from HTML when available", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const prismTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.colorSystemId === "color-system:prism";
    });
    if (prismTemplate === undefined) {
      throw new Error("Prism presentation template not found");
    }
    const blobHtml: Promise<string>[] = [];
    const { createObjectURL, revokeObjectURL } = mockUrlObjectMethods(
      (blob) => {
        blobHtml.push(blob.text());
        return `blob:template-preview-${String(blobHtml.length)}`;
      },
    );
    const htmlForFrame = (frame: HTMLElement): Promise<string> => {
      const src = frame.getAttribute("src");
      if (src === null) {
        throw new Error("Preview frame src not set");
      }
      const match = /^blob:template-preview-(\d+)$/.exec(src);
      if (match === null) {
        throw new Error(`Unexpected preview frame src: ${src}`);
      }
      const html = blobHtml[Number(match[1]) - 1];
      if (html === undefined) {
        throw new Error(`Preview blob not found for ${src}`);
      }
      return html;
    };
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      return new Response(
        `
          <!doctype html>
          <html>
            <body>
              <section data-vm0-slide data-slide-id="slide-one">
                <h1>Slide one</h1>
              </section>
              <section data-vm0-slide data-slide-id="slide-two">
                <h1>Slide two</h1>
              </section>
            </body>
          </html>
        `,
        { headers: { "Content-Type": "text/html" } },
      );
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    expect(
      screen.queryByLabelText(`View template ${template.title}`),
    ).not.toBeInTheDocument();
    const currentPreviewFrame = () => {
      return screen.getByTestId(`${template.title} card HTML preview`);
    };
    expect(
      screen.queryByTestId(`${template.title} card HTML preview`),
    ).not.toBeInTheDocument();
    const preview = screen.getByLabelText(
      `Preview ${template.title} at current slide`,
    ).parentElement;
    if (!preview) {
      throw new Error("Template preview not found");
    }
    Object.defineProperty(preview, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 0, 300, 160);
      },
    });

    fireEvent.mouseEnter(preview);
    await waitFor(() => {
      expect(
        screen.queryByTestId(`${template.title} card HTML preview`),
      ).not.toBeInTheDocument();
    });

    fireEvent.mouseEnter(preview);
    fireEvent.mouseMove(preview, { clientX: 300, clientY: 80 });

    await waitFor(async () => {
      await expect(htmlForFrame(currentPreviewFrame())).resolves.toContain(
        "Slide two",
      );
    });
    expect(currentPreviewFrame()).toHaveAttribute("tabindex", "-1");
    const secondPreviewHtml = await htmlForFrame(currentPreviewFrame());
    expect(secondPreviewHtml).toContain("--accent:#FF7A1A");
    expect(secondPreviewHtml).toContain("--s2:#F5B73E");
    expect(secondPreviewHtml).not.toContain("--fd:");
    expect(secondPreviewHtml).not.toContain("--fb:");
    const createObjectUrlCountBeforeLeave = createObjectURL.mock.calls.length;
    fireEvent.mouseLeave(preview);
    await waitFor(() => {
      expect(
        screen.queryByTestId(`${template.title} card HTML preview`),
      ).not.toBeInTheDocument();
    });
    expect(createObjectURL).toHaveBeenCalledTimes(
      createObjectUrlCountBeforeLeave,
    );

    const currentPrismPreviewFrame = () => {
      return screen.getByTestId(`${prismTemplate.title} card HTML preview`);
    };
    expect(
      screen.queryByTestId(`${prismTemplate.title} card HTML preview`),
    ).not.toBeInTheDocument();
    const prismPreview = screen.getByLabelText(
      `Preview ${prismTemplate.title} at current slide`,
    ).parentElement;
    if (!prismPreview) {
      throw new Error("Prism template preview not found");
    }
    Object.defineProperty(prismPreview, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 0, 300, 160);
      },
    });

    fireEvent.mouseEnter(prismPreview);
    await waitFor(() => {
      expect(
        screen.queryByTestId(`${prismTemplate.title} card HTML preview`),
      ).not.toBeInTheDocument();
    });
    fireEvent.mouseMove(prismPreview, { clientX: 300, clientY: 80 });
    await waitFor(() => {
      expect(
        screen.getByTestId(`${prismTemplate.title} card HTML preview`),
      ).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    });
    const prismFrame = currentPrismPreviewFrame();
    const prismFrameUrl = prismFrame.getAttribute("src");
    if (prismFrameUrl === null) {
      throw new Error("Prism preview frame URL not found");
    }
    const prismPreviewHtml = await htmlForFrame(prismFrame);
    expect(prismPreviewHtml).toContain("--accent:#7257E6");
    expect(prismPreviewHtml).toContain("--s1:#FF6B4A");
    expect(prismPreviewHtml).toContain("--s2:#AEE63E");
    fireEvent.load(prismFrame);
    await waitFor(() => {
      expect(currentPrismPreviewFrame()).toHaveAttribute("data-loaded", "true");
    });
    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(revokeObjectURL).toHaveBeenCalledWith(prismFrameUrl);
  });

  it("scrubs presentation card slides by slide count after the hover preview loads", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.slug === "bloom-pitch";
    });
    if (template === undefined) {
      throw new Error("Bloom pitch presentation template not found");
    }
    const slideCount = template.slideCount;
    if (slideCount === undefined) {
      throw new Error("Bloom pitch presentation slide count not found");
    }
    expect(template.previewImages).toHaveLength(1);
    expect(slideCount).toBe(15);
    const previewFetch = context.mocks.deferred<Response>();
    const blobHtml: Promise<string>[] = [];
    mockUrlObjectMethods((blob) => {
      blobHtml.push(blob.text());
      return `blob:template-preview-late-${String(blobHtml.length)}`;
    });
    const htmlForFrame = (frame: HTMLElement): Promise<string> => {
      const src = frame.getAttribute("src");
      if (src === null) {
        throw new Error("Preview frame src not set");
      }
      const match = /^blob:template-preview-late-(\d+)$/.exec(src);
      if (match === null) {
        throw new Error(`Unexpected preview frame src: ${src}`);
      }
      const html = blobHtml[Number(match[1]) - 1];
      if (html === undefined) {
        throw new Error(`Preview blob not found for ${src}`);
      }
      return html;
    };
    let previewFetchCount = 0;
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      previewFetchCount += 1;
      return previewFetch.promise;
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    const preview = screen.getByLabelText(
      `Preview ${template.title} at current slide`,
    ).parentElement;
    if (!preview) {
      throw new Error("Template preview not found");
    }
    Object.defineProperty(preview, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 0, 300, 160);
      },
    });

    previewFetch.resolve(
      new Response(
        `<!doctype html><html><body>${Array.from(
          { length: slideCount },
          (_, index) => {
            const slideNumber = index + 1;
            return `<section data-vm0-slide data-slide-id="slide-${slideNumber}"><h1>Slide ${slideNumber}</h1></section>`;
          },
        ).join("")}</body></html>`,
        { headers: { "Content-Type": "text/html" } },
      ),
    );
    fireEvent.mouseEnter(preview);
    await waitFor(() => {
      expect(previewFetchCount).toBe(1);
    });

    await waitFor(async () => {
      fireEvent.mouseMove(preview, { clientX: 300, clientY: 80 });
      await expect(
        htmlForFrame(screen.getByTestId(`${template.title} card HTML preview`)),
      ).resolves.toContain("Slide 15");
    });
  });

  it("uses the presentation detail theme for template selection", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.slug === "botane-organic-deck";
    });
    if (template === undefined) {
      throw new Error("Botane organic presentation template not found");
    }
    let selectedColorSystemId: string | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate: (body) => {
        const template = sentInlineTemplate(body.userMessage);
        if (template?.type === "presentation") {
          selectedColorSystemId = template.selection.colorSystemId;
        }
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    // Type the prompt before picking a template: the picker inserts the
    // template at the caret, and typing over a freshly selected node replaces
    // it.
    await fill(await findComposerEditor(), "Create a launch deck");

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    expect(
      screen.queryByLabelText(`Change theme for ${template.title}`),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByLabelText(`Preview ${template.title} at current slide`),
    );
    const templateDialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(
        within(templateDialog).getByRole("heading", {
          name: `Template / ${template.title}`,
        }),
      ).toBeInTheDocument();
    });
    const initialDetailImage = within(templateDialog).getByTestId(
      `${template.title} detail image preview`,
    );
    const initialDetailImageSrc = initialDetailImage.getAttribute("src");
    const initialHighResolutionDetailImage =
      initialDetailImage.parentElement?.querySelector<HTMLImageElement>(
        '[data-template-preview-image="high"]',
      );
    if (
      initialHighResolutionDetailImage === null ||
      initialHighResolutionDetailImage === undefined
    ) {
      throw new Error("High-resolution detail preview image not found");
    }
    fireEvent.load(initialDetailImage);
    const initialHighResolutionDetailImageSrc =
      initialHighResolutionDetailImage.getAttribute("src");
    if (initialHighResolutionDetailImageSrc === null) {
      throw new Error("High-resolution detail preview URL not found");
    }
    fireEvent.load(initialHighResolutionDetailImage);
    expect(initialHighResolutionDetailImage).toHaveAttribute(
      "data-loaded",
      "true",
    );
    const prismCardPreview = template.cardPreviewImagesByTheme?.prism;
    if (!prismCardPreview) {
      throw new Error("Prism card preview not found");
    }
    await user.click(
      within(templateDialog).getByLabelText("Select style Candy party"),
    );
    expect(
      within(templateDialog).getByLabelText("Select style Candy party"),
    ).toHaveAttribute("aria-pressed", "true");
    const prismDetailImage = within(templateDialog).getByTestId(
      `${template.title} detail image preview`,
    );
    expect(prismDetailImage).toBe(initialDetailImage);
    expect(prismDetailImage).toHaveAttribute(
      "src",
      r2ImageTransformUrl(prismCardPreview, {
        width: 224,
        height: 126,
      }),
    );
    const highResolutionDetailImage =
      prismDetailImage.parentElement?.querySelector<HTMLImageElement>(
        '[data-template-preview-image="high"]',
      );
    if (
      highResolutionDetailImage === null ||
      highResolutionDetailImage === undefined
    ) {
      throw new Error("High-resolution detail preview image not found");
    }
    expect(highResolutionDetailImage).toBe(initialHighResolutionDetailImage);
    expect(highResolutionDetailImage).toHaveAttribute(
      "src",
      initialHighResolutionDetailImageSrc,
    );
    expect(highResolutionDetailImage).toHaveAttribute("data-loaded", "true");
    expect(highResolutionDetailImage).toHaveAttribute(
      "data-src",
      prismCardPreview,
    );
    expect(initialDetailImageSrc).not.toBe(
      r2ImageTransformUrl(prismCardPreview, {
        width: 480,
        height: 270,
      }),
    );

    await user.click(within(templateDialog).getByLabelText("Preview slide 2"));
    const secondSlideDetailImage = within(templateDialog).getByTestId(
      `${template.title} detail image preview`,
    );
    const secondSlideHighResolutionImage =
      secondSlideDetailImage.parentElement?.querySelector<HTMLImageElement>(
        '[data-template-preview-image="high"]',
      );
    if (
      secondSlideHighResolutionImage === null ||
      secondSlideHighResolutionImage === undefined
    ) {
      throw new Error("High-resolution detail preview image not found");
    }
    expect(secondSlideDetailImage).toBe(initialDetailImage);
    expect(secondSlideHighResolutionImage).toBe(
      initialHighResolutionDetailImage,
    );
    expect(secondSlideHighResolutionImage).toHaveAttribute(
      "src",
      initialHighResolutionDetailImageSrc,
    );
    expect(secondSlideHighResolutionImage).toHaveAttribute(
      "data-loaded",
      "true",
    );
    expect(secondSlideHighResolutionImage).toHaveAttribute(
      "data-src",
      template.previewImages[1],
    );
    expect(secondSlideDetailImage).toHaveAttribute(
      "src",
      r2ImageTransformUrl(template.previewImages[1]!, {
        width: 224,
        height: 126,
      }),
    );

    fireEvent.load(secondSlideDetailImage);
    await waitFor(() => {
      expect(secondSlideHighResolutionImage).toHaveAttribute(
        "src",
        secondSlideHighResolutionImage.dataset.src,
      );
      expect(secondSlideHighResolutionImage).not.toHaveAttribute("data-loaded");
    });

    await user.click(within(templateDialog).getByLabelText("Preview slide 11"));
    const eleventhSlideDetailImage = within(templateDialog).getByTestId(
      `${template.title} detail image preview`,
    );
    const eleventhSlideHighResolutionImage =
      eleventhSlideDetailImage.parentElement?.querySelector<HTMLImageElement>(
        '[data-template-preview-image="high"]',
      );
    if (
      eleventhSlideHighResolutionImage === null ||
      eleventhSlideHighResolutionImage === undefined
    ) {
      throw new Error("High-resolution detail preview image not found");
    }
    expect(eleventhSlideDetailImage).toHaveAttribute(
      "src",
      r2ImageTransformUrl(template.previewImages[10]!, {
        width: 224,
        height: 126,
      }),
    );
    expect(eleventhSlideHighResolutionImage).toHaveAttribute(
      "data-src",
      template.previewImages[10],
    );
    expect(eleventhSlideHighResolutionImage).not.toHaveAttribute(
      "data-src",
      expect.stringContaining("presentation-gallery"),
    );

    const detailUseButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.getAttribute("aria-label") ===
            `Select template ${template.title}` &&
          candidate.closest("[inert]") === null
        );
      },
    );
    if (!detailUseButton) {
      throw new Error("Presentation detail Use button not found");
    }
    await user.click(detailUseButton);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await expectInlineTemplateInComposer(template.title);
    await user.click(
      screen.getByLabelText(`Preview template ${template.title}`),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId(`${template.title} card image preview`),
      ).toHaveAttribute(
        "src",
        r2ImageTransformUrl(prismCardPreview, { width: 480, height: 270 }),
      );
    });
    expect(
      screen.queryByLabelText(`Change theme for ${template.title}`),
    ).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Send"));
    await waitFor(() => {
      expect(selectedColorSystemId).toBe("color-system:prism");
    });
  });

  it("uses the gallery image only after the detail HTML preview fails", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.slug === "botane-organic-deck";
    });
    if (template === undefined) {
      throw new Error("Botane organic presentation template not found");
    }
    const previewFetch = context.mocks.deferred<Response>();
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      return previewFetch.promise;
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await user.click(
      screen.getByLabelText(`Preview ${template.title} at current slide`),
    );
    const templateDialog = screen.getByRole("dialog");
    await user.click(within(templateDialog).getByLabelText("Preview slide 11"));
    const detailImage = within(templateDialog).getByTestId(
      `${template.title} detail image preview`,
    );
    const highResolutionImage =
      detailImage.parentElement?.querySelector<HTMLImageElement>(
        '[data-template-preview-image="high"]',
      );
    if (highResolutionImage === null || highResolutionImage === undefined) {
      throw new Error("High-resolution detail preview image not found");
    }
    expect(highResolutionImage).toHaveAttribute(
      "data-src",
      template.previewImages[10],
    );

    previewFetch.resolve(new Response(null, { status: 500 }));

    await waitFor(() => {
      expect(highResolutionImage).toHaveAttribute(
        "data-src",
        `https://static.vm0.io/web/assets/presentation-gallery/2026-07-04/${template.slug}/slide-011.webp`,
      );
    });
  });

  it("updates the visible detail preview frame when the theme changes", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.slug === "editorial-magazine-deck";
    });
    if (template === undefined) {
      throw new Error("Editorial magazine presentation template not found");
    }

    const blobHtml: Promise<string>[] = [];
    const { revokeObjectURL } = mockUrlObjectMethods((blob) => {
      blobHtml.push(blob.text());
      return `blob:detail-theme-preview-${String(blobHtml.length)}`;
    });

    mockChatLifecycle(context, { threadId: THREAD_ID });
    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await user.click(
      screen.getByLabelText(`Preview ${template.title} at current slide`),
    );
    const templateDialog = screen.getByRole("dialog");
    const frame = () => {
      return within(templateDialog).getByTestId(
        `${template.title} detail HTML preview`,
      );
    };
    await waitFor(() => {
      expect(frame()).toHaveAttribute(
        "src",
        expect.stringMatching(/^blob:detail-theme-preview-/),
      );
    });
    expect(frame()).not.toHaveAttribute("data-loaded");
    expect(
      within(templateDialog).getByTestId(
        `${template.title} detail image preview`,
      ),
    ).toBeInTheDocument();
    fireEvent.load(frame());
    await waitFor(() => {
      expect(frame()).toHaveAttribute("data-loaded", "true");
    });
    const initialFrameSrc = frame().getAttribute("src");
    if (initialFrameSrc === null) {
      throw new Error("Initial detail preview frame URL not found");
    }
    const firstThumbnail = () => {
      return within(templateDialog).getByLabelText(
        `${template.title} slide 1 preview`,
      );
    };
    const secondThumbnail = () => {
      return within(templateDialog).getByLabelText(
        `${template.title} slide 2 preview`,
      );
    };
    const initialThumbnailAccent = firstThumbnail().getAttribute("style");
    const initialSecondThumbnailAccent =
      secondThumbnail().getAttribute("style");
    expect(firstThumbnail().parentElement?.querySelector("img")).not.toBeNull();
    expect(
      secondThumbnail().parentElement?.querySelector("img"),
    ).not.toBeNull();

    await user.click(
      within(templateDialog).getByLabelText("Select style Candy party"),
    );
    await waitFor(() => {
      expect(frame()).toHaveAttribute(
        "src",
        expect.stringMatching(/^blob:detail-theme-preview-/),
      );
      expect(frame().getAttribute("src")).not.toBe(initialFrameSrc);
    });
    expect(frame()).not.toHaveAttribute("data-loaded");
    const previousFrame = templateDialog.querySelector(
      '[data-template-detail-frame="previous"]',
    );
    expect(previousFrame).toHaveAttribute("src", initialFrameSrc);
    expect(previousFrame).toHaveAttribute("data-loaded", "true");
    fireEvent.load(frame());
    await waitFor(() => {
      expect(frame()).toHaveAttribute("data-loaded", "true");
      expect(
        templateDialog.querySelector('[data-template-detail-frame="previous"]'),
      ).not.toBeInTheDocument();
    });
    expect(revokeObjectURL).toHaveBeenCalledWith(initialFrameSrc);

    const themedFrameSrc = frame().getAttribute("src");
    if (themedFrameSrc === null) {
      throw new Error("Themed detail preview frame URL not found");
    }
    const match = /^blob:detail-theme-preview-(\d+)$/.exec(themedFrameSrc);
    if (match === null) {
      throw new Error(`Unexpected detail preview frame URL: ${themedFrameSrc}`);
    }
    const themedHtml = await blobHtml[Number(match[1]) - 1];
    expect(themedHtml).toContain("--accent:#7257E6");
    await waitFor(() => {
      const themedThumbnailAccent = firstThumbnail().getAttribute("style");
      expect(themedThumbnailAccent).toContain("--accent: #7257E6");
      expect(themedThumbnailAccent).not.toBe(initialThumbnailAccent);
      const themedSecondThumbnailAccent =
        secondThumbnail().getAttribute("style");
      expect(themedSecondThumbnailAccent).toContain("--accent: #7257E6");
      expect(themedSecondThumbnailAccent).not.toBe(
        initialSecondThumbnailAccent,
      );
    });
    const closeButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return candidate.getAttribute("aria-label") === "Close";
      },
    );
    if (!closeButton) {
      throw new Error("Close button not found");
    }
    await user.click(closeButton);
    expect(revokeObjectURL).toHaveBeenCalledWith(themedFrameSrc);
  });

  it("selects presentation templates with the default card theme", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.slug !== PRESENTATION_TEMPLATE_PICKER_ITEMS[0]?.slug;
    });
    if (template === undefined) {
      throw new Error("Second presentation template not found");
    }
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    expect(
      screen.queryByLabelText(`Change theme for ${template.title}`),
    ).not.toBeInTheDocument();

    click(screen.getByLabelText(`Preview ${template.title} at current slide`));
    const templateDialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(
        within(templateDialog).getByRole("heading", {
          name: `Template / ${template.title}`,
        }),
      ).toBeInTheDocument();
    });
    expect(
      within(templateDialog).getByLabelText("Select style Lavender dusk"),
    ).toHaveAttribute("aria-pressed", "true");

    const templateButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!templateButton) {
      throw new Error("Template button not found");
    }
    click(templateButton);

    expect(
      screen.queryByLabelText(`Change theme for ${template.title}`),
    ).not.toBeInTheDocument();

    click(screen.getByLabelText(`Select template ${template.title}`));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await expectInlineTemplateInComposer(template.title);
  });

  it("opens presentation template detail at the scrubbed card slide", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const lastSlideNumber = template.slideCount;
    if (lastSlideNumber === undefined) {
      throw new Error("Presentation template slide count not found");
    }
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      return new Response(
        `
          <!doctype html>
          <html>
            <body>
              ${Array.from({ length: lastSlideNumber }, (_, index) => {
                return `<section data-vm0-slide data-slide-id="slide-${String(
                  index + 1,
                )}"><h1>Slide ${String(index + 1)}</h1></section>`;
              }).join("")}
            </body>
          </html>
        `,
        { headers: { "Content-Type": "text/html" } },
      );
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );

    const preview = screen.getByLabelText(
      `Preview ${template.title} at current slide`,
    ).parentElement;
    if (!preview) {
      throw new Error("Template preview not found");
    }
    Object.defineProperty(preview, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 0, 300, 160);
      },
    });

    fireEvent.mouseEnter(preview);
    await waitFor(() => {
      expect(
        screen.queryByTestId(`${template.title} card HTML preview`),
      ).not.toBeInTheDocument();
    });
    fireEvent.mouseMove(preview, { clientX: 300, clientY: 80 });
    const animationFrame = context.mocks.deferred<void>();
    window.requestAnimationFrame(() => {
      animationFrame.resolve();
    });
    await animationFrame.promise;
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Preview slide ${String(lastSlideNumber)}`),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(
      screen.queryByText(`${String(lastSlideNumber)} of 15`),
    ).not.toBeInTheDocument();
  });

  it("preserves presentation template grid scroll when returning from detail preview", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );

    const initialScrollContainer = presentationTemplateGridScrollContainer();
    initialScrollContainer.scrollTop = 360;
    fireEvent.scroll(initialScrollContainer);
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    const templateDialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(
        within(templateDialog).getByRole("heading", {
          name: `Template / ${template.title}`,
        }),
      ).toBeInTheDocument();
    });

    click(within(templateDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(presentationTemplateGridScrollContainer().scrollTop).toBe(360);
    });

    const restoredAfterClose = presentationTemplateGridScrollContainer();
    restoredAfterClose.scrollTop = 520;
    fireEvent.scroll(restoredAfterClose);
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));
    await waitFor(() => {
      expect(
        within(templateDialog).getByRole("heading", {
          name: `Template / ${template.title}`,
        }),
      ).toBeInTheDocument();
    });

    const templateButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!templateButton) {
      throw new Error("Template button not found");
    }
    click(templateButton);

    await waitFor(() => {
      expect(presentationTemplateGridScrollContainer().scrollTop).toBe(520);
    });
  });

  it("starts presentation detail loading from preview and resumes it after reopening", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const previewFetch = context.mocks.deferred<Response>();
    let previewFetchCount = 0;
    const blobHtml: Promise<string>[] = [];
    mockUrlObjectMethods((blob) => {
      blobHtml.push(blob.text());
      return `blob:template-detail-${String(blobHtml.length)}`;
    });
    const htmlForDetailFrame = (frame: HTMLElement): Promise<string> => {
      const src = frame.getAttribute("src");
      if (src === null) {
        throw new Error("Detail preview frame src not set");
      }
      const match = /^blob:template-detail-(\d+)$/.exec(src);
      if (match === null) {
        throw new Error(`Unexpected detail preview frame src: ${src}`);
      }
      const html = blobHtml[Number(match[1]) - 1];
      if (html === undefined) {
        throw new Error(`Detail preview blob not found for ${src}`);
      }
      return html;
    };
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", ({ request }) => {
      const requestedUrl = new URL(request.url).searchParams.get("url");
      if (requestedUrl === template.embedUrl) {
        previewFetchCount += 1;
        return previewFetch.promise;
      }
      return new Response("<!doctype html><html><body></body></html>", {
        headers: { "Content-Type": "text/html" },
      });
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    await waitFor(() => {
      expect(previewFetchCount).toBe(1);
      expect(
        screen.queryByTestId(`${template.title} detail HTML preview`),
      ).not.toBeInTheDocument();
    });

    const templateButton = queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === "Template";
    });
    if (!templateButton) {
      throw new Error("Template button not found");
    }
    click(templateButton);
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    previewFetch.resolve(
      new Response(
        `
            <!doctype html>
            <html>
              <body>
                <section data-vm0-slide data-slide-id="slide-one">
                  <h1>Slide one</h1>
                </section>
              </body>
            </html>
          `,
        { headers: { "Content-Type": "text/html" } },
      ),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId(`${template.title} detail HTML preview`),
      ).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    });
    await expect(
      htmlForDetailFrame(
        screen.getByTestId(`${template.title} detail HTML preview`),
      ),
    ).resolves.toContain("Slide one");
    expect(previewFetchCount).toBe(1);
    const reopenedTemplateButton = queryAllByRoleFast("button").find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!reopenedTemplateButton) {
      throw new Error("Template button not found");
    }
    click(reopenedTemplateButton);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:template-detail-1");
  });

  // This test used to also cover the theme lifecycle, which put two independent
  // contracts plus page bootstrap into one 5000ms budget and left ~1.1s of
  // margin on a healthy CI runner. The theme lifecycle now has its own test.
  // Navigation keeps the render assertions that share its warm preview state,
  // so neither test re-pays for loading a cold detail preview.
  it("navigates presentation template detail previews from the main preview", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockStyledPresentationDeck(template);
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const templateDialog = await openPresentationDetailPreview(template);
    expect(
      within(templateDialog).getByRole("heading", {
        name: `Template / ${template.title}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Preview previous slide")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByLabelText("Preview previous slide")).not.toHaveClass(
      "focus-visible:ring-ring",
    );
    expect(screen.getByLabelText("Preview next slide")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByLabelText("Preview next slide")).not.toHaveClass(
      "focus-visible:ring-ring",
    );

    await waitFor(() => {
      expect(
        within(templateDialog).getByLabelText("Preview slide 1"),
      ).toHaveAttribute("aria-pressed", "true");
    });
    const detailPreviewFrame = screen.getByTestId(
      `${template.title} detail HTML preview`,
    );
    expect(detailPreviewFrame).toHaveAttribute("tabindex", "-1");
    expect(detailPreviewFrame).toHaveAttribute(
      "src",
      expect.stringMatching(/^blob:/),
    );
    expect(screen.queryByText("1 of 15")).not.toBeInTheDocument();
    const firstSlidePreviewButton =
      within(templateDialog).getByLabelText("Preview slide 1");
    const secondSlidePreviewButton =
      within(templateDialog).getByLabelText("Preview slide 2");
    const backButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!backButton) {
      throw new Error("Template button not found");
    }
    backButton.focus();
    fireEvent.keyDown(backButton, { key: "Tab" });
    expect(document.activeElement).toBe(firstSlidePreviewButton);
    fireEvent.keyDown(firstSlidePreviewButton, { key: "Tab" });
    expect(document.activeElement).toBe(secondSlidePreviewButton);
    expect(firstSlidePreviewButton.querySelector("iframe")).toBeNull();
    expect(firstSlidePreviewButton.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("width=224,height=126"),
    );
    expect(
      firstSlidePreviewButton.querySelector(
        `[aria-label="${template.title} slide 1 preview"]`,
      ),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        firstSlidePreviewButton.querySelector(
          `[aria-label="${template.title} slide 1 preview"]`,
        )?.shadowRoot,
      ).not.toBeNull();
    });
    const carnivalShadowRoot = firstSlidePreviewButton.querySelector(
      `[aria-label="${template.title} slide 1 preview"]`,
    )?.shadowRoot;
    const carnivalShadowPreviewRoot =
      carnivalShadowRoot?.querySelector<HTMLElement>(
        ".vm0-shadow-preview-root",
      ) ?? null;
    expect(carnivalShadowPreviewRoot?.style.getPropertyValue("--accent")).toBe(
      "#FF7A1A",
    );
    expect(
      carnivalShadowRoot?.querySelector("[contenteditable]"),
    ).not.toBeInTheDocument();
    expect(
      carnivalShadowRoot?.querySelector("[tabindex]"),
    ).not.toBeInTheDocument();
    expect(firstSlidePreviewButton.querySelectorAll("span")).toHaveLength(1);
    expect(screen.getByLabelText("Select style Funfair")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(
      screen.getByLabelText(`${template.title} slide preview`),
      {
        key: "ArrowRight",
      },
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.keyDown(
      screen.getByLabelText(`${template.title} slide preview`),
      {
        key: "ArrowLeft",
      },
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 1")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    const themeButton = screen.getByLabelText("Select style Funfair");
    themeButton.focus();
    expect(themeButton).toHaveFocus();
    fireEvent.keyDown(themeButton, {
      key: "ArrowRight",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.keyDown(themeButton, {
      key: "ArrowLeft",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 1")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.keyDown(screen.getByLabelText("Preview slide 1"), {
      key: "ArrowRight",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.keyDown(screen.getByLabelText("Preview slide 2"), {
      key: "ArrowLeft",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 1")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("restores the default presentation detail theme when the preview reopens", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockStyledPresentationDeck(template);
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const templateDialog = await openPresentationDetailPreview(template);
    const firstSlidePreviewButton =
      within(templateDialog).getByLabelText("Preview slide 1");
    await waitFor(() => {
      expect(
        firstSlidePreviewButton.querySelector(
          `[aria-label="${template.title} slide 1 preview"]`,
        )?.shadowRoot,
      ).not.toBeNull();
    });
    const carnivalShadowRoot = firstSlidePreviewButton.querySelector(
      `[aria-label="${template.title} slide 1 preview"]`,
    )?.shadowRoot;
    const carnivalShadowPreviewRoot =
      carnivalShadowRoot?.querySelector<HTMLElement>(
        ".vm0-shadow-preview-root",
      ) ?? null;
    expect(carnivalShadowPreviewRoot?.style.getPropertyValue("--accent")).toBe(
      "#FF7A1A",
    );

    click(screen.getByLabelText("Select style Candy party"));
    expect(screen.getByLabelText("Select style Candy party")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const prismSlidePreviewButton =
      within(templateDialog).getByLabelText("Preview slide 1");
    expect(prismSlidePreviewButton.querySelector("iframe")).toBeNull();
    // Switching the theme restyles the existing shadow root instead of
    // remounting the preview, so the accent changes in place.
    expect(
      prismSlidePreviewButton.querySelector(
        `[aria-label="${template.title} slide 1 preview"]`,
      )?.shadowRoot,
    ).toBe(carnivalShadowRoot);
    expect(carnivalShadowPreviewRoot?.style.getPropertyValue("--accent")).toBe(
      "#7257E6",
    );
    expect(prismSlidePreviewButton.querySelectorAll("span")).toHaveLength(1);

    const templateButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!templateButton) {
      throw new Error("Template button not found");
    }
    click(templateButton);
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    await waitFor(() => {
      expect(
        within(templateDialog).getByLabelText("Preview slide 1"),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByLabelText("Select style Funfair")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("selects an illustration style from the picker", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Illustration")).toBeInTheDocument();
    });
    click(tabByText("Illustration"));

    const heroAlt = `${illustrationTemplate.title} illustration preview`;
    const heroSrc = (index: number) => {
      return r2ImageTransformUrl(illustrationTemplate.previewImages[index]!, {
        width: 1024,
        quality: 72,
      });
    };

    await waitFor(() => {
      expect(screen.getByText(illustrationTemplate.title)).toBeInTheDocument();
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
      expect(screen.getAllByAltText(/ illustration preview$/u)).toHaveLength(
        ILLUSTRATION_TEMPLATE_ITEMS.length,
      );
    });

    // Variant thumbnails switch the hero inline within the card; there is no
    // longer a second preview dialog.
    const card = screen
      .getByAltText(heroAlt)
      .closest<HTMLElement>("[data-illustration-template-card]");
    if (!card) {
      throw new Error("Illustration card not found");
    }
    click(within(card).getByLabelText("Show variant 2"));
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(1));
    });
    click(within(card).getByLabelText("Show variant 1"));
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });

    expect(screen.queryByLabelText("Search templates")).toBeNull();
    click(
      screen.getByLabelText(`Select template ${illustrationTemplate.title}`),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await expectInlineTemplateInComposer(illustrationTemplate.title);
  });

  it("scrolls illustration thumbnails only after clicking a variant thumbnail", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.previewImages.length >= 4;
    });
    if (!illustrationTemplate) {
      throw new Error("Illustration template with four variants not found");
    }
    const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
    const scrollTo = vi.fn<HTMLElement["scrollTo"]>();
    const rect = ({
      left,
      right,
    }: {
      left: number;
      right: number;
    }): DOMRect => {
      return {
        x: left,
        y: 0,
        top: 0,
        left,
        right,
        bottom: 48,
        width: right - left,
        height: 48,
        toJSON: () => {
          return {};
        },
      };
    };
    const mockElementRect = (
      element: Element,
      bounds: { left: number; right: number },
    ) => {
      Object.defineProperty(element, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          return rect(bounds);
        },
      });
    };
    const mockScrollLeft = (element: Element, value: number) => {
      Object.defineProperty(element, "scrollLeft", {
        configurable: true,
        value,
        writable: true,
      });
    };
    const mockScrollSize = (
      element: Element,
      {
        scrollWidth,
        clientWidth,
      }: { scrollWidth: number; clientWidth: number },
    ) => {
      Object.defineProperty(element, "scrollWidth", {
        configurable: true,
        value: scrollWidth,
      });
      Object.defineProperty(element, "clientWidth", {
        configurable: true,
        value: clientWidth,
      });
    };
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 200,
          bottom: 200,
          width: 200,
          height: 200,
          toJSON: () => {
            return {};
          },
        };
      },
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Illustration")).toBeInTheDocument();
    });
    click(tabByText("Illustration"));

    const heroAlt = `${illustrationTemplate.title} illustration preview`;
    const heroSrc = (index: number) => {
      return r2ImageTransformUrl(illustrationTemplate.previewImages[index]!, {
        width: 1024,
        quality: 72,
      });
    };
    const lastIndex = illustrationTemplate.previewImages.length - 1;

    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    const card = screen
      .getByAltText(heroAlt)
      .closest<HTMLElement>("[data-illustration-template-card]");
    if (!card) {
      throw new Error("Illustration card not found");
    }

    // Clicking the rightmost visible thumbnail reveals the next two thumbnails.
    const variant1Thumbnail = within(card).getByLabelText("Show variant 1");
    const variant2Thumbnail = within(card).getByLabelText("Show variant 2");
    const variant3Thumbnail = within(card).getByLabelText("Show variant 3");
    const variant4Thumbnail = within(card).getByLabelText("Show variant 4");
    const thumbnailStrip = variant2Thumbnail.parentElement;
    if (!thumbnailStrip) {
      throw new Error("Illustration thumbnail strip not found");
    }
    mockScrollLeft(thumbnailStrip, 0);
    mockScrollSize(thumbnailStrip, { scrollWidth: 240, clientWidth: 96 });
    mockElementRect(thumbnailStrip, { left: 0, right: 96 });
    mockElementRect(variant2Thumbnail, { left: 48, right: 96 });
    mockElementRect(variant3Thumbnail, { left: 104, right: 152 });
    mockElementRect(variant4Thumbnail, { left: 160, right: 208 });
    click(variant2Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(1));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 144 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking the active thumbnail at the right edge still reveals the next
    // two thumbnails.
    scrollTo.mockClear();
    click(variant2Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(1));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 144 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Move to the last thumbnail without scrolling the thumbnail strip, then
    // click left to reveal the two thumbnails before the clicked one.
    scrollTo.mockClear();
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 190 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(2));
    });
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 190 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(3));
    });
    expect(scrollTo).not.toHaveBeenCalled();
    mockScrollLeft(thumbnailStrip, 112);
    mockElementRect(variant1Thumbnail, { left: -96, right: -48 });
    mockElementRect(variant3Thumbnail, { left: 0, right: 48 });
    click(variant3Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(2));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking the active thumbnail at the left edge still reveals the previous
    // two thumbnails.
    scrollTo.mockClear();
    click(variant3Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(2));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking near the left boundary scrolls all the way to the start.
    scrollTo.mockClear();
    mockScrollLeft(thumbnailStrip, 64);
    mockElementRect(variant1Thumbnail, { left: -16, right: 32 });
    click(variant1Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Switching away and back to Illustration remounts the active thumbnail but
    // must not scroll the dialog.
    scrollTo.mockClear();
    scrollIntoView.mockClear();
    click(tabByText("Presentation"));
    click(tabByText("Illustration"));
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking the hero halves changes variants without scrolling thumbnails.
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 10 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute(
        "src",
        heroSrc(lastIndex),
      );
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking the right half from the last variant wraps to the first one.
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 190 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking near the right boundary scrolls all the way to the end.
    const remountedCard = screen
      .getByAltText(heroAlt)
      .closest<HTMLElement>("[data-illustration-template-card]");
    if (!remountedCard) {
      throw new Error("Remounted illustration card not found");
    }
    const remountedVariant4Thumbnail =
      within(remountedCard).getByLabelText("Show variant 4");
    const remountedThumbnailStrip = remountedVariant4Thumbnail.parentElement;
    if (!remountedThumbnailStrip) {
      throw new Error("Remounted illustration thumbnail strip not found");
    }
    scrollTo.mockClear();
    mockScrollLeft(remountedThumbnailStrip, 120);
    mockScrollSize(remountedThumbnailStrip, {
      scrollWidth: 240,
      clientWidth: 96,
    });
    mockElementRect(remountedThumbnailStrip, { left: 0, right: 96 });
    mockElementRect(remountedVariant4Thumbnail, { left: 48, right: 96 });
    click(remountedVariant4Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(3));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 144 });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("renders video templates in the default template picker", async () => {
    const videoStyle = VIDEO_TEMPLATE_ITEMS[0]!;
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );

    await waitFor(() => {
      expect(tabByText("Presentation")).toBeInTheDocument();
      expect(tabByText("Illustration")).toBeInTheDocument();
      expect(tabByText("Video")).toBeInTheDocument();
    });
    click(tabByText("Video"));

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Select video template ${videoStyle.title}`),
      ).toBeInTheDocument();
      const posterUrl = r2ImageTransformUrl(
        videoStyle.cardPreviewImage ?? videoStyle.previewImage,
        {
          width: 480,
          height: 270,
        },
      );
      const previewVideo = document
        .querySelector(`source[src="${videoStyle.previewVideo}"]`)
        ?.closest("video");
      if (!(previewVideo instanceof HTMLVideoElement)) {
        throw new Error("Video template preview video not found");
      }
      const previewRoot = previewVideo.closest("[data-video-template-preview]");
      if (!previewRoot) {
        throw new Error("Video template preview root not found");
      }
      expect(
        previewRoot.querySelector("[data-video-template-poster]"),
      ).toHaveAttribute("src", posterUrl);
      expect(
        previewVideo.querySelector('source[type="video/webm; codecs=vp9"]'),
      ).toHaveAttribute("src", videoStyle.previewWebm);
      expect(previewVideo).toHaveAttribute("poster", posterUrl);
      expect(previewVideo).toHaveAttribute("preload", "none");
      expect(
        screen.getByLabelText(
          `Play video template preview ${videoStyle.title}`,
        ),
      ).toBeInTheDocument();
    });

    const previewVideo = document
      .querySelector(`source[src="${videoStyle.previewVideo}"]`)
      ?.closest("video");
    if (!(previewVideo instanceof HTMLVideoElement)) {
      throw new Error("Video template preview video not found");
    }
    const previewRoot = previewVideo.closest("[data-video-template-preview]");
    if (!previewRoot) {
      throw new Error("Video template preview root not found");
    }
    const previewPlayButton = screen.getByLabelText(
      `Play video template preview ${videoStyle.title}`,
    );
    fireEvent.click(previewPlayButton);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(previewVideo.defaultMuted).toBeTruthy();
    expect(previewVideo.muted).toBeTruthy();
    expect(previewVideo.preload).toBe("metadata");
    fireEvent.playing(previewVideo);
    expect(previewVideo.dataset.previewPlaying).toBe("true");

    previewVideo.currentTime = 3;
    fireEvent.mouseLeave(previewRoot);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(previewVideo.currentTime).toBe(0);
    expect(previewVideo.dataset.previewPlaying).toBe("false");

    fireEvent.mouseEnter(previewRoot);
    expect(playSpy).toHaveBeenCalledTimes(2);
    previewVideo.currentTime = 4;
    Object.defineProperty(previewVideo, "paused", {
      configurable: true,
      value: false,
    });
    fireEvent.click(previewPlayButton);
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(previewVideo.currentTime).toBe(4);
  });

  it("renders a selected template inline during an active run and clears the picker state", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockActiveTemplateThread();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    await selectTemplate(user, template);
    const activeComposer = await screen.findByRole("textbox", {
      name: "Message",
    });
    await sendMessageInUI(user, activeComposer, "Steer with a matching deck");

    await waitFor(() => {
      expect(
        screen.getByText("Steer with a matching deck"),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps newer template selections visible after an inline template steer", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const nextTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    mockActiveTemplateThread();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    await selectTemplate(user, template);
    await appendAndSend(user, "Steer with a matching deck");

    await waitFor(() => {
      expect(
        screen.getByText("Steer with a matching deck"),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });

    await selectIllustrationTemplate(user, nextTemplate);

    await waitFor(() => {
      expect(
        composerInlineTemplates().map((node) => {
          return node.textContent;
        }),
      ).toStrictEqual([nextTemplate.title]);
    });
  });

  it("selects a video template from the picker", async () => {
    const videoStyle = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.title === "Luxury Product Macro";
    })!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Video")).toBeInTheDocument();
    });
    click(tabByText("Video"));

    await waitFor(() => {
      expect(screen.queryByText("Brand & Commercial")).not.toBeInTheDocument();
      expect(
        screen.getByLabelText(`Select video template ${videoStyle.title}`),
      ).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Search templates")).toBeNull();
    click(screen.getByLabelText(`Select video template ${videoStyle.title}`));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        composerInlineTemplates().map((node) => {
          return node.textContent;
        }),
      ).toStrictEqual([videoStyle.title]);
    });
  });

  it("opens compare plans from video templates when the workspace cannot generate video", async () => {
    const videoStyle = VIDEO_TEMPLATE_ITEMS[0]!;
    const user = userEvent.setup({ delay: null });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus("limited-free-1"));
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await user.click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await user.click(
      await waitFor(() => {
        return tabByText("Video");
      }),
    );

    const upgrade = await waitFor(() => {
      const found = queryAllByRoleFast("button").find((candidate) => {
        return (
          candidate.getAttribute("aria-label") ===
          `View plans for video template ${videoStyle.title}`
        );
      });
      if (found === undefined) {
        throw new Error("Video template plan button not found");
      }
      return found;
    });
    expect(upgrade).toHaveTextContent("Need Pro");

    await user.click(upgrade);

    await expect(
      screen.findByRole("heading", { name: "Choose a plan" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Template" })).toBeNull();
    expect(composerInlineTemplates()).toHaveLength(0);
  });

  it("selects and sends a workflow template from the picker", async () => {
    const user = userEvent.setup({ delay: null });
    const workflowTemplate = WORKFLOW_TEMPLATE_ITEMS[0]!;
    let submittedTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate: (body) => {
        submittedTemplate = sentInlineTemplate(body.userMessage);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Workflow")).toBeInTheDocument();
    });
    click(tabByText("Workflow"));

    await waitFor(() => {
      expect(screen.getByText(workflowTemplate.title)).toBeInTheDocument();
      expect(
        screen.getByText(workflowTemplate.description),
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Search templates")).toHaveAttribute(
      "placeholder",
      "Search templates",
    );
    await fill(screen.getByLabelText("Search templates"), "no workflow match");
    await waitFor(() => {
      expect(screen.getByText("No matches")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search templates"), "auto-inbox");
    click(
      screen.getByLabelText(
        `Select workflow template ${workflowTemplate.title}`,
      ),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await expectInlineTemplateInComposer(workflowTemplate.title);

    await appendAndSend(user, "Create this inbox workflow");

    await waitFor(() => {
      expect(submittedTemplate).toStrictEqual({
        type: "workflow",
        selection: { workflowTemplateId: workflowTemplate.id },
      });
      expect(composerInlineTemplates()).toHaveLength(0);
    });
  });

  it("localizes the workflow catalog in the picker", async () => {
    const workflowTemplate = WORKFLOW_TEMPLATE_ITEMS[0]!;
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Modelo");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Fluxo de trabalho")).toBeInTheDocument();
    });
    click(tabByText("Fluxo de trabalho"));

    // The catalog ships English copy; the card and the persona pills read the
    // reader's language instead.
    await waitFor(() => {
      expect(
        screen.getByText("Marcador automático da caixa de entrada"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(workflowTemplate.title)).toBeNull();
    expect(screen.queryByText(workflowTemplate.description)).toBeNull();
    expect(screen.getByText("Engenharia")).toBeInTheDocument();
  });

  it("selects and sends a website template", async () => {
    const user = userEvent.setup({ delay: null });
    const websiteTemplate = WEBSITE_TEMPLATE_ITEMS[0]!;
    const websiteTemplatePreviewImageUrl = r2ImageTransformUrl(
      websiteTemplate.previewImageUrl,
      { width: 480, height: 270 },
    );
    let submittedTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate: (body) => {
        submittedTemplate = sentInlineTemplate(body.userMessage);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    // Type the prompt before picking a template: the picker inserts the
    // template at the caret, and typing over a freshly selected node replaces
    // it.
    await fill(await findComposerEditor(), "Create a warm website");

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Website")).toBeInTheDocument();
    });
    click(tabByText("Website"));

    await waitFor(() => {
      expect(
        screen.getByLabelText(
          `Select website template ${websiteTemplate.title}`,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByTitle(`${websiteTemplate.title} website template preview`),
      ).toHaveAttribute("src", websiteTemplatePreviewImageUrl);
      expect(
        screen.getByTitle(`${websiteTemplate.title} website template preview`)
          .tagName,
      ).toBe("IMG");
      expect(screen.queryByText(websiteTemplate.description)).toBeNull();
      expect(screen.queryByText(websiteTemplate.resourceId)).toBeNull();
      expect(screen.queryByText("Saas Landing")).not.toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Search templates")).toBeNull();
    click(
      screen.getByLabelText(`Select website template ${websiteTemplate.title}`),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await expectInlineTemplateInComposer(websiteTemplate.title);

    // The inline template node opens the picker on mousedown, which the
    // lightweight `click` helper does not dispatch.
    await user.click(
      screen.getByLabelText(
        `Preview website template ${websiteTemplate.title}`,
      ),
    );
    await waitFor(() => {
      expect(tabByText("Website")).toHaveAttribute("aria-selected", "true");
      expect(
        screen.getByTitle(`${websiteTemplate.title} website template preview`),
      ).toHaveAttribute("src", websiteTemplatePreviewImageUrl);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });

    click(
      within(screen.getByRole("dialog")).getByLabelText(
        `Preview website template ${websiteTemplate.title}`,
      ),
    );
    await waitFor(() => {
      expect(
        screen.getByTitle(`${websiteTemplate.title} website full preview`),
      ).toHaveAttribute("src", websiteTemplate.previewUrl);
      expect(
        screen.getByTitle(
          `${websiteTemplate.title} website preview placeholder`,
        ),
      ).toHaveAttribute("src", websiteTemplatePreviewImageUrl);
      expect(
        screen.queryByTitle(
          `${websiteTemplate.title} website template preview`,
        ),
      ).not.toBeInTheDocument();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });
    const websitePreviewDialog = screen.getByRole("dialog", {
      name: `Website / ${websiteTemplate.title}`,
    });
    fireEvent.load(
      screen.getByTitle(`${websiteTemplate.title} website full preview`),
    );
    click(within(websitePreviewDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByTitle(`${websiteTemplate.title} website full preview`),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTitle(`${websiteTemplate.title} website template preview`),
      ).toHaveAttribute("src", websiteTemplatePreviewImageUrl);
      expect(tabByText("Website")).toHaveAttribute("aria-selected", "true");
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });

    click(
      within(screen.getByRole("dialog")).getByLabelText(
        `Preview website template ${websiteTemplate.title}`,
      ),
    );
    await waitFor(() => {
      expect(
        screen.getByTitle(`${websiteTemplate.title} website full preview`),
      ).toHaveAttribute("src", websiteTemplate.previewUrl);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });
    const reopenedWebsitePreviewDialog = screen.getByRole("dialog", {
      name: `Website / ${websiteTemplate.title}`,
    });
    const websiteBackButton = queryAllByRoleFast(
      "button",
      reopenedWebsitePreviewDialog,
    ).find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === "Website";
    });
    if (!websiteBackButton) {
      throw new Error("Website back button not found");
    }
    click(websiteBackButton);
    await waitFor(() => {
      expect(
        screen.queryByTitle(`${websiteTemplate.title} website full preview`),
      ).not.toBeInTheDocument();
      expect(tabByText("Website")).toHaveAttribute("aria-selected", "true");
    });
    expect(
      screen.getByRole("dialog", {
        name: "Template",
      }),
    ).toBeInTheDocument();
    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(submittedTemplate).toStrictEqual({
        type: "website",
        selection: { websiteTemplateId: websiteTemplate.id },
      });
      expect(composerInlineTemplates()).toHaveLength(0);
    });
  });
  it("lists uploaded decks ahead of built-ins and uses one in the next message", async () => {
    const user = userEvent.setup({ delay: null });
    let submittedTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        submittedTemplate = sentInlineTemplate(body.userMessage);
      },
    });
    const importedTemplate = {
      id: "8f5c9a1e-6f7d-4a2b-9c3e-0d1a2b3c4d5e",
      title: "Brand system",
      sourceFilename: "brand-system.pptx",
      coverUrl: "https://example.com/imported-cover.png",
      pageCount: 18,
      visibility: "public" as const,
      canManage: false,
      pageUrls: [
        "https://example.com/imported-cover.png",
        "https://example.com/imported-page-2.png",
      ],
      createdAt: "2026-08-21T02:41:59.522Z",
      updatedAt: "2026-08-21T02:41:59.522Z",
    };
    setMockPresentationTemplates([importedTemplate]);

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );

    const card = await waitFor(() => {
      const found = document.querySelector(
        '[data-imported-presentation-template="8f5c9a1e-6f7d-4a2b-9c3e-0d1a2b3c4d5e"]',
      );
      if (!found) {
        throw new Error("Imported template card not found");
      }
      return found as HTMLElement;
    });
    expect(within(card).getByText("Brand system")).toBeInTheDocument();
    // The tile caption carries the title alone: the slide count and the
    // visibility marker both belong to the detail panel, which is one click
    // away and has room to say them properly.
    expect(within(card).queryByText("18 slides")).toBeNull();
    expect(card.querySelector(".lucide-globe")).toBeNull();
    const coverImage = within(card).getByRole("img");
    expect(coverImage).toHaveAttribute(
      "src",
      "https://example.com/imported-cover.png",
    );
    expect(coverImage).toHaveAttribute("loading", "eager");
    expect(coverImage).toHaveAttribute("fetchpriority", "high");
    const coverPlaceholder = card.querySelector(
      "[data-imported-presentation-template-image-placeholder]",
    );
    expect(coverPlaceholder).not.toHaveAttribute("hidden");
    fireEvent.load(coverImage);
    await waitFor(() => {
      expect(coverPlaceholder).toHaveAttribute("hidden");
    });

    // Grid order is the import tile, then this user's decks, then the
    // built-ins: a returning user looks for their own deck first.
    const grid = card.parentElement;
    if (!grid) {
      throw new Error("Imported template card has no grid");
    }
    const tiles = Array.from(grid.children);
    expect(tiles.indexOf(card)).toBe(1);
    expect(tiles[0]).toHaveAttribute("data-presentation-template-import");

    const useButton = queryAllByRoleFast("button", card).find((candidate) => {
      return candidate.textContent?.trim() === "Use";
    });
    if (!useButton) {
      throw new Error("Imported template Use button not found");
    }
    await user.click(useButton);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await expectInlineTemplateInComposer("Brand system");

    await appendAndSend(user, "Use this brand system");
    await waitFor(() => {
      expect(submittedTemplate).toStrictEqual({
        type: "presentation",
        selection: {
          templateId: "user-template:8f5c9a1e-6f7d-4a2b-9c3e-0d1a2b3c4d5e",
          previewUrl: "https://example.com/imported-cover.png",
        },
      });
    });
  });

  it("caches stable uploaded preview assets without preloading closed picker covers", async () => {
    const user = userEvent.setup({ delay: null });
    mockNow(context.signal, new Date("2026-08-23T03:00:00.000Z").getTime());
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const primaryTemplateId = "7e4d2a91-40f8-4ea0-b685-e8653776f912";
    const secondaryTemplateId = "9f374525-03cd-4b37-bfe7-71880c8bf84c";
    const primaryPageUrls = Array.from({ length: 100 }, (_, index) => {
      return `https://example.com/prefetch-primary-page-${index + 1}.png`;
    });
    const secondaryPageUrls = Array.from({ length: 100 }, (_, index) => {
      return `https://example.com/prefetch-secondary-page-${index + 1}.png`;
    });
    const primaryPreviewAssetIds = primaryPageUrls.map((_, index) => {
      return `ptp:${primaryTemplateId}:primary-${index.toString().padStart(3, "0")}`;
    });
    const secondaryPreviewAssetIds = secondaryPageUrls.map((_, index) => {
      return `ptp:${secondaryTemplateId}:secondary-${index.toString().padStart(3, "0")}`;
    });
    const primaryTemplate = {
      id: primaryTemplateId,
      title: "Primary draft deck",
      sourceFilename: "primary-brand-system.pptx",
      coverUrl: primaryPageUrls[0] ?? null,
      pageCount: primaryPageUrls.length,
      visibility: "public" as const,
      canManage: false,
      pageUrls: primaryPageUrls,
      previewAssets: primaryPreviewAssetIds.map((previewAssetId, index) => {
        return {
          previewAssetId,
          url: primaryPageUrls[index]!,
          expiresAt: "2026-08-23T03:15:00.000Z",
        };
      }),
      createdAt: "2026-08-23T03:00:00.000Z",
      updatedAt: "2026-08-23T03:00:00.000Z",
    };
    const secondaryTemplate = {
      id: secondaryTemplateId,
      title: "Secondary draft deck",
      sourceFilename: "secondary-brand-system.pptx",
      coverUrl: secondaryPageUrls[0] ?? null,
      pageCount: secondaryPageUrls.length,
      visibility: "private" as const,
      canManage: true,
      pageUrls: secondaryPageUrls,
      previewAssets: secondaryPreviewAssetIds.map((previewAssetId, index) => {
        return {
          previewAssetId,
          url: secondaryPageUrls[index]!,
          expiresAt: "2026-08-23T03:15:00.000Z",
        };
      }),
      createdAt: "2026-08-23T03:00:00.000Z",
      updatedAt: "2026-08-23T03:00:00.000Z",
    };
    const { pageUrls: _primaryPageUrls, ...primaryCatalogEntry } =
      primaryTemplate;
    const { pageUrls: _secondaryPageUrls, ...secondaryCatalogEntry } =
      secondaryTemplate;
    let catalogRequestCount = 0;
    let primaryDetailRequestCount = 0;
    let secondaryDetailRequestCount = 0;
    let previewUrlRequestCount = 0;
    context.mocks.api(presentationTemplatesContract.list, ({ respond }) => {
      catalogRequestCount += 1;
      return respond(200, [primaryCatalogEntry, secondaryCatalogEntry]);
    });
    context.mocks.api(
      presentationTemplatesContract.get,
      ({ params, respond }) => {
        if (params.templateId === primaryTemplateId) {
          primaryDetailRequestCount += 1;
          return respond(200, primaryTemplate);
        }
        expect(params.templateId).toBe(secondaryTemplateId);
        secondaryDetailRequestCount += 1;
        return respond(200, secondaryTemplate);
      },
    );
    context.mocks.api(
      presentationTemplatesContract.resolvePreviewUrls,
      ({ respond }) => {
        previewUrlRequestCount += 1;
        return respond(200, { assets: [] });
      },
    );

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(catalogRequestCount).toBe(1);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      document.querySelectorAll('img[src^="https://example.com/prefetch-"]'),
    ).toHaveLength(0);
    expect(primaryDetailRequestCount).toBe(0);
    expect(secondaryDetailRequestCount).toBe(0);
    expect(previewUrlRequestCount).toBe(0);

    await user.click(screen.getByLabelText("Template"));
    const dialog = screen.getByRole("dialog");
    const card = await waitFor(() => {
      const found = dialog.querySelector(
        `[data-imported-presentation-template="${primaryTemplateId}"]`,
      );
      if (!(found instanceof HTMLElement)) {
        throw new Error("Uploaded template card not found");
      }
      return found;
    });
    const secondaryCard = dialog.querySelector(
      `[data-imported-presentation-template="${secondaryTemplateId}"]`,
    );
    if (!(secondaryCard instanceof HTMLElement)) {
      throw new Error("Secondary template card not found");
    }
    const previewUrlRequestCountBeforeOpen = previewUrlRequestCount;
    await waitFor(() => {
      expect(catalogRequestCount).toBe(1);
      expect(primaryDetailRequestCount).toBe(0);
    });
    expect(previewUrlRequestCount).toBe(previewUrlRequestCountBeforeOpen);
    expect(within(card).getByRole("img")).toHaveAttribute("loading", "eager");
    expect(within(card).getByRole("img")).toHaveAttribute(
      "fetchpriority",
      "high",
    );
    expect(within(secondaryCard).getByRole("img")).toHaveAttribute(
      "loading",
      "eager",
    );
    expect(within(secondaryCard).getByRole("img")).toHaveAttribute(
      "fetchpriority",
      "high",
    );
    const previewButton = within(card).getByLabelText(
      "Preview Primary draft deck at current slide",
    );
    const preview = previewButton.parentElement;
    if (!preview) {
      throw new Error("Imported template preview not found");
    }
    Object.defineProperty(preview, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 0, 300, 160);
      },
    });
    fireEvent.load(within(preview).getByRole("img"));
    fireEvent.mouseEnter(preview);
    fireEvent.mouseMove(preview, { clientX: 4, clientY: 80 });
    await loadImportedTemplateImage(
      preview,
      "https://example.com/prefetch-primary-page-2.png",
    );

    expect(within(preview).getByRole("img")).toHaveAttribute(
      "src",
      "https://example.com/prefetch-primary-page-2.png",
    );
    fireEvent.mouseLeave(preview);
    await loadImportedTemplateImage(
      preview,
      "https://example.com/prefetch-primary-page-1.png",
    );
    expect(within(preview).getByRole("img")).toHaveAttribute(
      "src",
      "https://example.com/prefetch-primary-page-1.png",
    );
    expect(catalogRequestCount).toBe(1);
    expect(primaryDetailRequestCount).toBe(0);
    expect(secondaryDetailRequestCount).toBe(0);

    const cardImage = within(card).getByRole("img");
    const previewUrlRequestCountBeforeRealtime = previewUrlRequestCount;
    context.mocks.ably.trigger("presentationTemplatesChanged");
    await waitFor(() => {
      expect(catalogRequestCount).toBe(2);
    });
    expect(previewUrlRequestCount).toBe(previewUrlRequestCountBeforeRealtime);
    expect(primaryDetailRequestCount).toBe(0);
    expect(secondaryDetailRequestCount).toBe(0);
    expect(within(card).getByRole("img")).toBe(cardImage);
    expect(cardImage).toHaveAttribute(
      "src",
      "https://example.com/prefetch-primary-page-1.png",
    );
  });

  it("renews an expiring uploaded preview before the picker opens", async () => {
    const user = userEvent.setup({ delay: null });
    const requestedAt = new Date("2026-08-23T03:00:00.000Z").getTime();
    mockNow(context.signal, requestedAt);
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const templateId = "245b3889-2835-40c4-898b-0effd621570d";
    const previewAssetId = `ptp:${templateId}:cover`;
    const oldUrl = "https://example.com/expiring-template-cover.png";
    const renewedUrl = "https://example.com/renewed-template-cover.png";
    const summary = {
      id: templateId,
      title: "Renewed brand deck",
      sourceFilename: "renewed-brand-deck.pptx",
      coverUrl: oldUrl,
      pageCount: 1,
      visibility: "private" as const,
      canManage: true,
      createdAt: "2026-08-23T03:00:00.000Z",
      updatedAt: "2026-08-23T03:00:00.000Z",
      previewAssets: [
        {
          previewAssetId,
          url: oldUrl,
          expiresAt: "2026-08-23T03:00:30.000Z",
        },
      ],
    };
    let catalogRequestCount = 0;
    let detailRequestCount = 0;
    let previewUrlRequestCount = 0;
    let resolvedPreviewAssetIds: readonly string[] = [];
    context.mocks.api(presentationTemplatesContract.list, ({ respond }) => {
      catalogRequestCount += 1;
      return respond(200, [summary]);
    });
    context.mocks.api(presentationTemplatesContract.get, ({ respond }) => {
      detailRequestCount += 1;
      return respond(200, {
        ...summary,
        pageUrls: [oldUrl],
      });
    });
    context.mocks.api(
      presentationTemplatesContract.resolvePreviewUrls,
      ({ body, respond }) => {
        previewUrlRequestCount += 1;
        resolvedPreviewAssetIds = body.previewAssetIds;
        return respond(200, {
          assets: [
            {
              previewAssetId,
              url: renewedUrl,
              expiresAt: "2026-08-23T03:15:00.000Z",
            },
          ],
        });
      },
    );

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(previewUrlRequestCount).toBe(1);
    });
    expect(document.querySelector(`img[src="${oldUrl}"]`)).toBeNull();
    expect(document.querySelector(`img[src="${renewedUrl}"]`)).toBeNull();
    expect(catalogRequestCount).toBe(1);
    expect(detailRequestCount).toBe(0);
    expect(resolvedPreviewAssetIds).toStrictEqual([previewAssetId]);

    await user.click(screen.getByLabelText("Template"));
    const card = await waitFor(() => {
      const found = screen
        .getByRole("dialog")
        .querySelector(`[data-imported-presentation-template="${templateId}"]`);
      if (!(found instanceof HTMLElement)) {
        throw new Error("Renewed template card not found");
      }
      return found;
    });
    await waitFor(() => {
      expect(within(card).getByRole("img")).toHaveAttribute("src", renewedUrl);
    });
    expect(catalogRequestCount).toBe(1);
    expect(detailRequestCount).toBe(0);
    expect(previewUrlRequestCount).toBe(1);
  });

  it("loads resized uploaded deck previews with bounded thumbnail priority", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const templateId = "6fbcce0d-cb09-42de-8d8a-d525f813f312";
    const pageUrls = Array.from({ length: 18 }, (_, index) => {
      const slideNumber = (index + 1).toString().padStart(3, "0");
      return `https://cdn.vm0.io/artifacts/user/template/page-${slideNumber}.png?X-Amz-Signature=slide-${slideNumber}`;
    });
    const coverUrl = pageUrls[0];
    if (coverUrl === undefined) {
      throw new Error("Uploaded template cover URL not found");
    }
    const cardCoverUrl = r2ImageTransformUrl(coverUrl, {
      width: 480,
      height: 270,
    });
    const highResolutionUrl = r2ImageTransformUrl(coverUrl, {
      width: 708,
      height: 398,
    });
    const template = {
      id: templateId,
      title: "Edge resized deck",
      sourceFilename: "edge-resized-deck.pptx",
      coverUrl,
      pageCount: pageUrls.length,
      visibility: "private" as const,
      canManage: true,
      pageUrls,
      createdAt: "2026-08-25T03:00:00.000Z",
      updatedAt: "2026-08-25T03:00:00.000Z",
    };
    let catalogRequestCount = 0;
    context.mocks.api(presentationTemplatesContract.list, ({ respond }) => {
      catalogRequestCount += 1;
      return respond(200, [presentationTemplateCatalogEntry(template)]);
    });
    context.mocks.api(
      presentationTemplatesContract.get,
      ({ params, respond }) => {
        expect(params.templateId).toBe(templateId);
        return respond(200, presentationTemplateDetail(template));
      },
    );

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(catalogRequestCount).toBe(1);
    });
    expect(document.querySelector(`img[src="${cardCoverUrl}"]`)).toBeNull();
    expect(document.querySelector(`img[src="${coverUrl}"]`)).toBeNull();

    await user.click(screen.getByLabelText("Template"));
    const dialog = screen.getByRole("dialog");
    const card = await waitFor(() => {
      const found = dialog.querySelector(
        `[data-imported-presentation-template="${templateId}"]`,
      );
      if (!(found instanceof HTMLElement)) {
        throw new Error("Resized uploaded template card not found");
      }
      return found;
    });
    const previewButton = within(card).getByLabelText(
      "Preview Edge resized deck at current slide",
    );
    const cardMedia = previewButton.parentElement;
    if (cardMedia === null) {
      throw new Error("Resized uploaded template card media not found");
    }
    await loadImportedTemplateImage(cardMedia, cardCoverUrl);
    click(previewButton);

    const detailPreview = await screen.findByTestId(
      "Edge resized deck imported detail image preview",
    );
    const lowResolutionImage = await requestedImportedTemplateImage(
      detailPreview,
      cardCoverUrl,
    );
    expect(lowResolutionImage).not.toHaveAttribute("src", highResolutionUrl);
    await loadImportedTemplateImage(detailPreview, cardCoverUrl);
    expect(activeImportedTemplateImage(detailPreview)).toBe(lowResolutionImage);
    const highResolutionImage = await requestedImportedTemplateImage(
      detailPreview,
      highResolutionUrl,
    );
    expect(activeImportedTemplateImage(detailPreview)).toBe(lowResolutionImage);
    fireEvent.load(highResolutionImage);
    await waitFor(() => {
      expect(activeImportedTemplateImage(detailPreview)).toBe(
        highResolutionImage,
      );
    });
    expect(highResolutionImage).toHaveAttribute("src", highResolutionUrl);

    const thumbnailCases = [
      { slideNumber: 1, loading: "eager", priority: "high" },
      { slideNumber: 16, loading: "eager", priority: "auto" },
      { slideNumber: 17, loading: "lazy", priority: "low" },
    ] as const;
    for (const { slideNumber, loading, priority } of thumbnailCases) {
      const thumbnailButton = await screen.findByLabelText(
        `Preview slide ${slideNumber.toString()}`,
      );
      const pageUrl = pageUrls[slideNumber - 1];
      if (pageUrl === undefined) {
        throw new Error("Uploaded template thumbnail URL not found");
      }
      const thumbnailUrl = r2ImageTransformUrl(pageUrl, {
        width: 224,
        height: 126,
      });
      const thumbnailImage = await requestedImportedTemplateImage(
        thumbnailButton,
        thumbnailUrl,
      );
      expect(thumbnailImage).toHaveAttribute("src", thumbnailUrl);
      expect(thumbnailImage).toHaveAttribute("loading", loading);
      expect(thumbnailImage).toHaveAttribute("fetchpriority", priority);
    }
  });

  it("makes a workspace template published after navigating away usable in the other thread", async () => {
    const user = userEvent.setup({ delay: null });
    const analysisCatalogLoaded = context.mocks.deferred<void>();
    const publishedCatalogLoaded = context.mocks.deferred<void>();
    const publishedTemplate = {
      id: "9a6d0b2f-7a8e-4c3d-9f1a-2b3c4d5e6f70",
      title: "Fresh deck",
      sourceFilename: "fresh-deck.pptx",
      coverUrl: "https://example.com/fresh-deck-cover.png",
      pageCount: 12,
      previewAssets: [
        {
          previewAssetId:
            "ptp:9a6d0b2f-7a8e-4c3d-9f1a-2b3c4d5e6f70:fresh-cover",
          url: "https://example.com/fresh-deck-cover.png",
          expiresAt: "2026-08-23T03:15:00.000Z",
        },
      ],
      visibility: "public" as const,
      canManage: false,
      createdAt: "2026-08-23T03:00:00.000Z",
      updatedAt: "2026-08-23T03:00:00.000Z",
    };
    let catalog: (typeof publishedTemplate)[] = [];
    context.mocks.api(presentationTemplatesContract.list, ({ respond }) => {
      if (catalog.length > 0 && !publishedCatalogLoaded.settled()) {
        publishedCatalogLoaded.resolve();
      }
      if (!analysisCatalogLoaded.settled()) {
        analysisCatalogLoaded.resolve();
      }
      return respond(200, catalog);
    });
    const lifecycle = mockChatLifecycle(context, { threadId: THREAD_ID });
    lifecycle.setThreadList([
      {
        id: THREAD_ID,
        title: "Template analysis",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-08-23T02:58:00.000Z",
        updatedAt: "2026-08-23T03:00:00.000Z",
      },
      {
        id: SUGGESTED_THREAD_ID,
        title: "Other deck work",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-08-23T02:57:00.000Z",
        updatedAt: "2026-08-23T02:59:00.000Z",
      },
    ]);

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    await analysisCatalogLoaded.promise;
    await appendAndSend(
      user,
      "Analyze my uploaded deck",
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await user.click(linkByText("Other deck work"));
    const otherThreadContainer = await waitFor(() => {
      expect(document.title).toBe("Other deck work | VM0");
      const container = document.querySelector(
        `[data-chat-thread-container-id="${SUGGESTED_THREAD_ID}"]`,
      );
      if (!(container instanceof HTMLElement)) {
        throw new Error("Other thread container not found");
      }
      return container;
    });

    catalog = [publishedTemplate];
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscriptionOnChannel(
          "org:org_default",
          "presentationTemplatesChanged",
        ),
      ).toBeTruthy();
    });
    context.mocks.ably.triggerOnChannel(
      "org:org_default",
      "presentationTemplatesChanged",
    );
    await publishedCatalogLoaded.promise;
    lifecycle.completeRun("Template published");

    click(within(otherThreadContainer).getByLabelText("Template"));
    await expect(screen.findByText("Fresh deck")).resolves.toBeInTheDocument();
    await user.click(screen.getByLabelText("Select template Fresh deck"));
    await expectInlineTemplateInComposer("Fresh deck");
  });

  it("drops a workspace template from an open picker once its owner makes it private", async () => {
    const sharedTemplate = {
      id: "3c7f1d84-5b2a-4e6f-8a90-1b2c3d4e5f61",
      title: "Workspace brand",
      sourceFilename: "workspace-brand.pptx",
      coverUrl: "https://example.com/workspace-brand-cover.png",
      pageCount: 6,
      visibility: "public" as const,
      canManage: false,
      pageUrls: ["https://example.com/workspace-brand-cover.png"],
      createdAt: "2026-08-23T03:00:00.000Z",
      updatedAt: "2026-08-23T03:00:00.000Z",
    };
    setMockPresentationTemplates([sharedTemplate]);
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    const dialog = await waitFor(() => {
      const card = document.querySelector(
        `[data-imported-presentation-template="${sharedTemplate.id}"]`,
      );
      if (!(card instanceof HTMLElement)) {
        throw new Error("Shared template card not found");
      }
      return screen.getByRole("dialog");
    });

    // The owner takes the deck back: the row leaves this member's catalog and
    // the workspace channel says so while the picker is still open.
    setMockPresentationTemplates([]);
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscriptionOnChannel(
          "org:org_default",
          "presentationTemplatesChanged",
        ),
      ).toBeTruthy();
    });
    context.mocks.ably.triggerOnChannel(
      "org:org_default",
      "presentationTemplatesChanged",
    );

    await waitFor(() => {
      expect(
        dialog.querySelector(
          `[data-imported-presentation-template="${sharedTemplate.id}"]`,
        ),
      ).toBeNull();
    });
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("scrubs every uploaded slide and manages an owned template from its detail view", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const templateId = "8f5c9a1e-6f7d-4a2b-9c3e-0d1a2b3c4d5e";
    setMockPresentationTemplates([
      {
        id: templateId,
        title: "Brand system",
        sourceFilename: "brand-system.pptx",
        coverUrl: "https://example.com/imported-cover.png",
        pageCount: 3,
        visibility: "private",
        canManage: true,
        pageUrls: [
          "https://example.com/imported-cover.png",
          "https://example.com/imported-page-2.png",
          "https://example.com/imported-page-3.png",
        ],
        createdAt: "2026-08-21T02:41:59.522Z",
        updatedAt: "2026-08-21T02:41:59.522Z",
      },
    ]);

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    click(await screen.findByLabelText("Template"));
    const previewButton = await screen.findByLabelText(
      "Preview Brand system at current slide",
    );
    const preview = previewButton.parentElement;
    if (!preview) {
      throw new Error("Imported template preview not found");
    }
    Object.defineProperty(preview, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 0, 300, 160);
      },
    });
    fireEvent.load(within(preview).getByRole("img"));
    fireEvent.mouseEnter(preview);
    fireEvent.mouseMove(preview, { clientX: 150, clientY: 80 });
    await loadImportedTemplateImage(
      preview,
      "https://example.com/imported-page-2.png",
    );
    expect(within(preview).getByRole("img")).toHaveAttribute(
      "src",
      "https://example.com/imported-page-2.png",
    );

    click(previewButton);
    const detailPreview = await screen.findByTestId(
      "Brand system imported detail image preview",
    );
    await loadImportedTemplateImage(
      detailPreview,
      "https://example.com/imported-page-2.png",
    );
    expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
      "src",
      "https://example.com/imported-page-2.png",
    );
    await user.click(screen.getByLabelText("Preview slide 3"));
    expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
      "src",
      "https://example.com/imported-page-2.png",
    );
    const stalePageThreeImage = await requestedImportedTemplateImage(
      detailPreview,
      "https://example.com/imported-page-3.png",
    );
    await user.click(screen.getByLabelText("Preview slide 2"));
    fireEvent.load(stalePageThreeImage);
    expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
      "src",
      "https://example.com/imported-page-2.png",
    );
    await user.click(screen.getByLabelText("Preview slide 3"));
    await loadImportedTemplateImage(
      detailPreview,
      "https://example.com/imported-page-3.png",
    );
    await waitFor(() => {
      expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
        "src",
        "https://example.com/imported-page-3.png",
      );
    });
    await user.click(screen.getByLabelText("Preview slide 2"));
    expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
      "src",
      "https://example.com/imported-page-3.png",
    );
    const stalePageTwoImage = await requestedImportedTemplateImage(
      detailPreview,
      "https://example.com/imported-page-2.png",
    );
    await user.click(screen.getByLabelText("Preview slide 1"));
    expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
      "src",
      "https://example.com/imported-page-3.png",
    );
    await loadImportedTemplateImage(
      detailPreview,
      "https://example.com/imported-cover.png",
    );
    await waitFor(() => {
      expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
        "src",
        "https://example.com/imported-cover.png",
      );
    });
    fireEvent.load(stalePageTwoImage);
    expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
      "src",
      "https://example.com/imported-cover.png",
    );
    const titleInput = screen.getByRole("textbox", {
      name: "Rename template",
    });
    await fill(titleInput, "  Brand   refresh  ");
    const renameButton = queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label") === "Rename template";
    });
    if (!renameButton) {
      throw new Error("Imported template Rename button not found");
    }
    await user.click(renameButton);
    // A wrapping field can take newlines and stray runs of spaces; the saved
    // name is still the single line the preview keys off.
    await expect(
      screen.findByTestId("Brand refresh imported detail image preview"),
    ).resolves.toBeInTheDocument();

    const changeVisibilityButton = queryAllByRoleFast("button").find(
      (candidate) => {
        return (
          candidate.getAttribute("aria-label") === "Change template visibility"
        );
      },
    );
    if (!changeVisibilityButton) {
      throw new Error("Imported template Change visibility button not found");
    }
    await user.click(changeVisibilityButton);
    await user.click(screen.getByRole("radio", { name: /^Workspace/ }));
    await waitFor(() => {
      expect(
        screen.getByText("Anyone in this workspace can use it"),
      ).toBeInTheDocument();
    });

    const initialDeleteButton = queryAllByRoleFast("button").find(
      (candidate) => {
        return candidate.textContent?.trim() === "Delete";
      },
    );
    if (!initialDeleteButton) {
      throw new Error("Imported template Delete button not found");
    }
    await user.click(initialDeleteButton);
    await waitFor(() => {
      expect(
        document.querySelector(
          `[data-imported-presentation-template="${templateId}"]`,
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("releases rename focus after confirming an uploaded template title", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });
    let template = presentationTemplateDetail({
      id: "34c41aed-b488-4e09-b7ea-23a712a270dd",
      title: "Focus deck",
      sourceFilename: "focus-deck.pptx",
      coverUrl: "https://example.com/focus-deck-cover.png",
      pageCount: 1,
      visibility: "private",
      canManage: true,
      pageUrls: ["https://example.com/focus-deck-cover.png"],
      createdAt: "2026-08-21T02:41:59.522Z",
      updatedAt: "2026-08-21T02:41:59.522Z",
    });
    setMockPresentationTemplates([template]);
    const updateStarted = context.mocks.deferred<void>();
    const releaseUpdate = context.mocks.deferred<void>();
    context.mocks.api(
      presentationTemplatesContract.update,
      async ({ body, params, respond }) => {
        expect(params.templateId).toBe(template.id);
        expect(body).toStrictEqual({ title: "Renamed focus deck" });
        updateStarted.resolve();
        await releaseUpdate.promise;
        template = {
          ...template,
          title: body.title ?? template.title,
          updatedAt: "2026-08-27T02:41:59.522Z",
        };
        return respond(200, presentationTemplateSummary(template));
      },
    );

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    click(await screen.findByLabelText("Template"));
    await user.click(
      await screen.findByLabelText("Preview Focus deck at current slide"),
    );
    const titleInput = await screen.findByRole("textbox", {
      name: "Rename template",
    });
    await fill(titleInput, "Renamed focus deck");
    const renameButton = queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label") === "Rename template";
    });
    if (!renameButton) {
      throw new Error("Imported template Rename button not found");
    }
    await user.click(renameButton);
    await updateStarted.promise;

    expect(renameButton).not.toHaveFocus();

    releaseUpdate.resolve();
    await expect(
      screen.findByTestId("Renamed focus deck imported detail image preview"),
    ).resolves.toBeInTheDocument();
  });

  it("keeps loaded uploaded slides mounted while visibility metadata refreshes", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });
    let template = presentationTemplateDetail({
      id: "ea583da0-6e8c-4ca4-9cb9-3a898c8d1850",
      title: "Stable preview deck",
      sourceFilename: "stable-preview-deck.pptx",
      coverUrl: "https://example.com/stable-preview-cover.png",
      pageCount: 3,
      visibility: "private",
      canManage: true,
      pageUrls: [
        "https://example.com/stable-preview-cover.png",
        "https://example.com/stable-preview-page-2.png",
        "https://example.com/stable-preview-page-3.png",
      ],
      createdAt: "2026-08-21T02:41:59.522Z",
      updatedAt: "2026-08-21T02:41:59.522Z",
    });
    let listRequestCount = 0;
    let detailRequestCount = 0;
    let updateRequestCount = 0;
    context.mocks.api(presentationTemplatesContract.list, ({ respond }) => {
      listRequestCount += 1;
      return respond(200, [presentationTemplateCatalogEntry(template)]);
    });
    context.mocks.api(
      presentationTemplatesContract.get,
      ({ params, respond }) => {
        expect(params.templateId).toBe(template.id);
        detailRequestCount += 1;
        return respond(200, template);
      },
    );
    context.mocks.api(
      presentationTemplatesContract.update,
      ({ body, params, respond }) => {
        expect(params.templateId).toBe(template.id);
        expect(body).toStrictEqual({ visibility: "public" });
        updateRequestCount += 1;
        template = {
          ...template,
          coverUrl:
            "https://example.com/stable-preview-cover.png?signature=renewed",
          visibility: "public",
          pageUrls: template.pageUrls.map((pageUrl) => {
            return `${pageUrl}?signature=renewed`;
          }),
          updatedAt: "2026-08-21T02:42:59.522Z",
        };
        return respond(200, presentationTemplateSummary(template));
      },
    );

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    click(await screen.findByLabelText("Template"));
    await user.click(
      await screen.findByLabelText(
        "Preview Stable preview deck at current slide",
      ),
    );
    const detailPreview = await screen.findByTestId(
      "Stable preview deck imported detail image preview",
    );
    await user.click(screen.getByLabelText("Preview slide 3"));
    await loadImportedTemplateImage(
      detailPreview,
      "https://example.com/stable-preview-page-3.png",
    );
    expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
      "src",
      "https://example.com/stable-preview-page-3.png",
    );
    const thumbnailButtons = [1, 2, 3].map((slideNumber) => {
      return screen.getByLabelText(`Preview slide ${slideNumber.toString()}`);
    });
    const initialPageUrls = template.pageUrls;
    for (const [index, button] of thumbnailButtons.entries()) {
      const pageUrl = initialPageUrls[index];
      if (pageUrl === undefined) {
        throw new Error("Uploaded template page URL not found");
      }
      await loadImportedTemplateImage(button, pageUrl);
    }
    const detailRequestCountBeforeUpdate = detailRequestCount;
    const listRequestCountBeforeUpdate = listRequestCount;
    expect(detailRequestCountBeforeUpdate).toBe(0);

    const changeVisibilityButton = queryAllByRoleFast("button").find(
      (candidate) => {
        return (
          candidate.getAttribute("aria-label") === "Change template visibility"
        );
      },
    );
    if (!changeVisibilityButton) {
      throw new Error("Imported template Change visibility button not found");
    }
    await user.click(changeVisibilityButton);
    await user.click(screen.getByRole("radio", { name: /^Workspace/ }));
    await waitFor(() => {
      expect(updateRequestCount).toBe(1);
      expect(
        screen.getByText("Anyone in this workspace can use it"),
      ).toBeInTheDocument();
    });
    expect(listRequestCount).toBe(listRequestCountBeforeUpdate);
    expect(detailRequestCount).toBe(detailRequestCountBeforeUpdate);
    expect(
      screen.getByTestId("Stable preview deck imported detail image preview"),
    ).toBe(detailPreview);
    expect(activeImportedTemplateImage(detailPreview)).toHaveAttribute(
      "src",
      "https://example.com/stable-preview-page-3.png",
    );
    for (const [index, button] of thumbnailButtons.entries()) {
      const expectedPageUrl = initialPageUrls[index];
      if (expectedPageUrl === undefined) {
        throw new Error("Uploaded template page URL not found");
      }
      expect(
        screen.getByLabelText(`Preview slide ${(index + 1).toString()}`),
      ).toBe(button);
      expect(activeImportedTemplateImage(button)).toHaveAttribute(
        "src",
        expectedPageUrl,
      );
    }
  });

  it("keeps remaining uploaded cards mounted while delete refresh is pending", async () => {
    const user = userEvent.setup({ delay: null });
    const requestedAt = new Date("2026-08-21T02:41:59.522Z").getTime();
    const expiringAt = new Date(requestedAt + 30 * 1000).toISOString();
    const renewedAt = new Date(requestedAt + 15 * 60 * 1000).toISOString();
    mockNow(context.signal, requestedAt);
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const deletedTemplateId = "e3b3a9c6-cad5-49d1-bdd3-ab4083501462";
    const deletedPageUrls = [
      "https://example.com/delete-this-deck-cover.png",
      "https://example.com/delete-this-deck-page-2.png",
    ];
    const deletedPreviewAssets = deletedPageUrls.map((url, index) => {
      return {
        previewAssetId: `ptp:${deletedTemplateId}:page-${index.toString()}`,
        url,
        expiresAt: expiringAt,
      };
    });
    const deletedTemplate = presentationTemplateDetail({
      id: deletedTemplateId,
      title: "Delete this deck",
      sourceFilename: "delete-this-deck.pptx",
      coverUrl: deletedPageUrls[0] ?? null,
      pageCount: 2,
      visibility: "private",
      canManage: true,
      pageUrls: deletedPageUrls,
      previewAssets: deletedPreviewAssets,
      createdAt: "2026-08-21T02:41:59.522Z",
      updatedAt: "2026-08-21T02:41:59.522Z",
    });
    const remainingTemplateId = "ba5e76aa-4082-47a8-9fb8-57e63857bba8";
    const remainingPageUrls = [
      "https://example.com/keep-this-deck-cover.png",
      "https://example.com/keep-this-deck-page-2.png",
    ];
    const remainingPreviewAssets = remainingPageUrls.map((url, index) => {
      return {
        previewAssetId: `ptp:${remainingTemplateId}:page-${index.toString()}`,
        url,
        expiresAt: expiringAt,
      };
    });
    const remainingTemplate = presentationTemplateDetail({
      id: remainingTemplateId,
      title: "Keep this deck",
      sourceFilename: "keep-this-deck.pptx",
      coverUrl: remainingPageUrls[0] ?? null,
      pageCount: 2,
      visibility: "private",
      canManage: true,
      pageUrls: remainingPageUrls,
      previewAssets: remainingPreviewAssets,
      createdAt: "2026-08-21T02:42:59.522Z",
      updatedAt: "2026-08-21T02:42:59.522Z",
    });
    let catalog = [deletedTemplate, remainingTemplate];
    let holdCatalogRefresh = false;
    let catalogRequestCount = 0;
    const deleteRefreshRequested = context.mocks.deferred<void>();
    const releaseDeleteRefresh = context.mocks.deferred<void>();
    const firstPreviewResolveRequested = context.mocks.deferred<void>();
    const releaseFirstPreviewResolve = context.mocks.deferred<void>();
    const previewResolveRequests: string[][] = [];
    const previewAssetsById = new Map(
      [...deletedPreviewAssets, ...remainingPreviewAssets].map((asset) => {
        return [asset.previewAssetId, asset] as const;
      }),
    );
    context.mocks.api(
      presentationTemplatesContract.list,
      async ({ respond }) => {
        catalogRequestCount += 1;
        if (holdCatalogRefresh) {
          deleteRefreshRequested.resolve();
          await releaseDeleteRefresh.promise;
        }
        return respond(200, catalog.map(presentationTemplateCatalogEntry));
      },
    );
    context.mocks.api(
      presentationTemplatesContract.resolvePreviewUrls,
      async ({ body, respond }) => {
        previewResolveRequests.push([...body.previewAssetIds]);
        if (previewResolveRequests.length === 1) {
          firstPreviewResolveRequested.resolve();
          await releaseFirstPreviewResolve.promise;
        }
        const expiresAt =
          previewResolveRequests.length === 1 ? expiringAt : renewedAt;
        return respond(200, {
          assets: body.previewAssetIds.flatMap((previewAssetId) => {
            const asset = previewAssetsById.get(previewAssetId);
            return asset === undefined ? [] : [{ ...asset, expiresAt }];
          }),
        });
      },
    );
    context.mocks.api(
      presentationTemplatesContract.get,
      ({ params, respond }) => {
        const template = catalog.find((candidate) => {
          return candidate.id === params.templateId;
        });
        if (!template) {
          return respond(404, {
            error: {
              code: "NOT_FOUND",
              message: `Presentation template not found: ${params.templateId}`,
            },
          });
        }
        return respond(200, template);
      },
    );
    context.mocks.api(
      presentationTemplatesContract.delete,
      ({ params, respond }) => {
        expect(params.templateId).toBe(deletedTemplate.id);
        catalog = catalog.filter((template) => {
          return template.id !== params.templateId;
        });
        holdCatalogRefresh = true;
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    await firstPreviewResolveRequested.promise;
    click(await screen.findByLabelText("Template"));
    await waitFor(() => {
      expect(catalogRequestCount).toBe(1);
    });
    const dialog = screen.getByRole("dialog");
    const deletedCard = dialog.querySelector<HTMLElement>(
      `[data-imported-presentation-template="${deletedTemplate.id}"]`,
    );
    const remainingCard = dialog.querySelector<HTMLElement>(
      `[data-imported-presentation-template="${remainingTemplate.id}"]`,
    );
    if (!deletedCard || !remainingCard) {
      throw new Error("Uploaded template cards not found");
    }
    const remainingCover = Array.from(
      remainingCard.querySelectorAll<HTMLImageElement>(
        "[data-imported-presentation-template-image]",
      ),
    ).find((image) => {
      return image.getAttribute("src") === remainingTemplate.coverUrl;
    });
    if (!remainingCover) {
      throw new Error("Remaining uploaded template cover not found");
    }
    fireEvent.load(remainingCover);
    await waitFor(() => {
      expect(remainingCover).toHaveAttribute(
        "data-loaded-image-url",
        remainingTemplate.coverUrl,
      );
    });
    const scrollContainer = presentationTemplateGridScrollContainer();
    scrollContainer.scrollTop = 187;
    fireEvent.scroll(scrollContainer);

    await user.click(
      within(deletedCard).getByLabelText(
        "Preview Delete this deck at current slide",
      ),
    );
    await screen.findByTestId("Delete this deck imported detail image preview");
    expect(deletedCard).toBeInTheDocument();
    expect(remainingCard).toBeInTheDocument();

    const deleteButton = queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.trim() === "Delete";
    });
    if (!deleteButton) {
      throw new Error("Imported template Delete button not found");
    }
    await user.click(deleteButton);
    await deleteRefreshRequested.promise;
    releaseFirstPreviewResolve.resolve();
    await waitFor(() => {
      expect(previewResolveRequests).toHaveLength(2);
    });
    expect(previewResolveRequests[1]).toStrictEqual(
      remainingPreviewAssets.map((asset) => {
        return asset.previewAssetId;
      }),
    );

    await waitFor(() => {
      expect(deletedCard).not.toBeInTheDocument();
    });
    expect(
      dialog.querySelector(
        `[data-imported-presentation-template="${remainingTemplate.id}"]`,
      ),
    ).toBe(remainingCard);
    expect(remainingCover).toBeInTheDocument();
    expect(remainingCover).toHaveAttribute(
      "data-loaded-image-url",
      remainingTemplate.coverUrl,
    );
    expect(scrollContainer.scrollTop).toBe(187);

    releaseDeleteRefresh.resolve();
    await waitFor(() => {
      expect(catalogRequestCount).toBe(2);
      expect(
        dialog.querySelector(
          `[data-imported-presentation-template="${deletedTemplate.id}"]`,
        ),
      ).not.toBeInTheDocument();
      expect(
        dialog.querySelector(
          `[data-imported-presentation-template="${remainingTemplate.id}"]`,
        ),
      ).toBe(remainingCard);
    });

    // A stale catalog response may finish after the delete refresh. The delete
    // is permanent, so it must not resurrect the card or its preview cache.
    holdCatalogRefresh = false;
    const refreshedRemainingTemplate = {
      ...remainingTemplate,
      title: "Keep this deck refreshed",
      updatedAt: "2026-08-21T02:43:59.522Z",
    };
    catalog = [deletedTemplate, refreshedRemainingTemplate];
    context.mocks.ably.trigger("presentationTemplatesChanged");
    await waitFor(() => {
      expect(catalogRequestCount).toBe(3);
      expect(screen.getByText("Keep this deck refreshed")).toBeInTheDocument();
      expect(
        dialog.querySelector(
          `[data-imported-presentation-template="${deletedTemplate.id}"]`,
        ),
      ).not.toBeInTheDocument();
    });
    expect(
      dialog.querySelector(
        `[data-imported-presentation-template="${remainingTemplate.id}"]`,
      ),
    ).toBe(remainingCard);
    expect(remainingCover).toBeInTheDocument();
    expect(scrollContainer.scrollTop).toBe(187);
  });

  it("imports an uploaded deck as an ordinary chat message", async () => {
    const user = userEvent.setup({ delay: null });
    let sentPrompt: string | undefined;
    let sentMessage: UserMessageDocument | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        sentPrompt = body.prompt;
        sentMessage = body.userMessage;
      },
    });
    context.mocks.upload.success({
      id: "upload-deck",
      filename: "brand-system.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      size: 2048,
      url: "https://cdn.vm7.io/artifacts/test/upload-deck/brand-system.pptx",
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    const importInput = await waitFor(() => {
      return screen.getByLabelText("Import your own deck");
    });

    await user.upload(
      importInput,
      new File(["deck"], "brand-system.pptx", {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );

    // Choosing a deck closes the picker and sends it: the import is a chat
    // message with the deck attached, not a separate upload flow.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      // What the user sees in their own thread is the request they would have
      // typed. How the run reaches the guide is carried by the agent tools
      // prompt, so none of it leaks into the message sent on their behalf.
      expect(sentPrompt).toBe(
        "Analyse this deck and save its visual language as a reusable presentation template.",
      );
      expect(sentMessage?.parts).toContainEqual(
        expect.objectContaining({
          type: "file",
          fileId: "upload-deck",
          filenameSnapshot: "brand-system.pptx",
        }),
      );
    });
  });

  it("imports a legacy binary .ppt deck", async () => {
    const user = userEvent.setup({ delay: null });
    let sentPrompt: string | undefined;
    let sentMessage: UserMessageDocument | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        sentPrompt = body.prompt;
        sentMessage = body.userMessage;
      },
    });
    context.mocks.upload.success({
      id: "upload-deck",
      filename: "brand-system.ppt",
      contentType: "application/vnd.ms-powerpoint",
      size: 2048,
      url: "https://cdn.vm7.io/artifacts/test/upload-deck/brand-system.ppt",
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    const importInput = await waitFor(() => {
      return screen.getByLabelText("Import your own deck");
    });
    // A deck saved in the legacy format is not filtered out of the file
    // picker.
    expect(importInput).toHaveAttribute(
      "accept",
      expect.stringContaining(".ppt,"),
    );

    await user.upload(
      importInput,
      new File(["deck"], "brand-system.ppt", {
        type: "application/vnd.ms-powerpoint",
      }),
    );

    await waitFor(() => {
      expect(sentPrompt).toContain("reusable presentation template");
      expect(sentMessage?.parts).toContainEqual(
        expect.objectContaining({
          type: "file",
          fileId: "upload-deck",
          filenameSnapshot: "brand-system.ppt",
        }),
      );
    });
  });

  it("does not send the import message when the deck upload fails", async () => {
    const user = userEvent.setup({ delay: null });
    const sentPrompts: (string | undefined)[] = [];
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        sentPrompts.push(body.prompt);
      },
    });
    context.mocks.upload.success({
      id: "upload-deck",
      filename: "brand-system.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      size: 2048,
      url: "https://cdn.vm7.io/artifacts/test/upload-deck/brand-system.pptx",
    });
    context.mocks.http.put("https://mock-upload.r2.test/upload-deck", () => {
      return new Response(null, { status: 500 });
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/chats/${THREAD_ID}`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    const importInput = await waitFor(() => {
      return screen.getByLabelText("Import your own deck");
    });

    await user.upload(
      importInput,
      new File(["deck"], "brand-system.pptx", {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Failed to upload brand-system.pptx"),
      ).toBeInTheDocument();
    });

    // The deck never arrived, so nothing is sent on the user's behalf. A plain
    // message afterwards is the only run, which pins that the import stopped at
    // the upload error instead of asking for an analysis of a missing file.
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await sendMessageInUI(user, composer, "Never mind the deck");

    await waitFor(() => {
      expect(sentPrompts).toStrictEqual(["Never mind the deck"]);
    });
  });

  it("creates the thread and starts the run when importing from a new chat", async () => {
    const user = userEvent.setup({ delay: null });
    let createdThreadId: string | undefined;
    let sentThreadId: string | undefined;
    let sentPrompt: string | undefined;
    mockOrgModelRoutes("claude-fable-5");
    mockAgent();
    mockChatLifecycle(context, {
      onThreadCreate(body) {
        createdThreadId = body.clientThreadId;
      },
      onSendRequest(body) {
        sentThreadId = body.threadId;
        sentPrompt = body.prompt;
      },
    });
    context.mocks.upload.success({
      id: "upload-deck",
      filename: "brand-system.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      size: 2048,
      url: "https://cdn.vm7.io/artifacts/test/upload-deck/brand-system.pptx",
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.PresentationTemplates]: true },
      path: `/agents/${AGENT_ID}/chat`,
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    const importInput = await waitFor(() => {
      return screen.getByLabelText("Import your own deck");
    });

    await user.upload(
      importInput,
      new File(["deck"], "brand-system.pptx", {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );

    // Importing from the new-thread composer creates the thread and then
    // navigates into it. Both calls have to survive that navigation: a signal
    // the navigation aborts leaves the user on a thread the server never
    // recorded, with no run to answer them and nothing on screen saying so.
    await waitFor(() => {
      expect(createdThreadId).toBeDefined();
      expect(sentPrompt).toContain("reusable presentation template");
      expect(sentThreadId).toBe(createdThreadId);
    });
  });

  it("hides the deck import entry when the switch is off", async () => {
    mockChatLifecycle(context, { threadId: THREAD_ID });
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Import your own deck"),
    ).not.toBeInTheDocument();
  });
});
