import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
  r2ImageTransformUrl,
} from "@vm0/core";
import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { templateCardThemeIdBySlug$ } from "../../../signals/zero-page/zero-chat-composer.ts";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";
import {
  context,
  AGENT_ID,
  THREAD_ID,
  tabByText,
  presentationTemplateGridScrollContainer,
  mockActiveTemplateThread,
  trackTemplatePreviewImagePreloads,
  mockImmediateIdleCallback,
  openTemplatePicker,
  selectTemplate,
  selectIllustrationTemplate,
  composerElementFrom,
  findComposerEditor,
  expectTemplateAttachedToComposer,
} from "./chat-composer-test-helpers.ts";

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
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
  it("inserts multiple inline templates and sends a template-only message", async () => {
    const user = userEvent.setup({ delay: null });
    const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const second = PRESENTATION_TEMPLATE_PICKER_ITEMS[1]!;
    let submittedUserMessage: UserMessageDocument | undefined;
    let submittedGenerationTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate(body) {
        submittedUserMessage = body.userMessage;
        submittedGenerationTemplate = body.generationTemplate;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.StructuredPrompt]: true,
        [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
      },
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
      expect(submittedGenerationTemplate).toBeUndefined();
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

  it("replaces a selected inline template instead of inserting another", async () => {
    const user = userEvent.setup({ delay: null });
    const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const replacement = PRESENTATION_TEMPLATE_PICKER_ITEMS[1]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.StructuredPrompt]: true,
        [FeatureSwitchKey.StructuredPromptInlineTemplates]: true,
      },
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
    const restoreIdleCallback = mockImmediateIdleCallback();
    const templatePreviewSrcs = () => {
      return imagePreloads.srcs.filter((src) => {
        return src.includes("/cdn-cgi/image/width=480,height=270");
      });
    };

    try {
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
    } finally {
      restoreIdleCallback();
      imagePreloads.restore();
    }
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

  it("places the template control immediately after upload when the popover switch is enabled", async () => {
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.ComposerUploadPopover]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );

    await waitFor(() => {
      const controls = Array.from(
        composer.querySelectorAll(
          [
            'button[aria-label="Upload"]',
            'button[aria-label="Template"]',
            'button[aria-label="Connectors"]',
          ].join(","),
        ),
      ).map((button) => {
        return button.getAttribute("aria-label");
      });

      expect(controls).toStrictEqual(["Upload", "Template", "Connectors"]);
      expect(
        composer.querySelector('button[aria-label="Attach"]'),
      ).not.toBeInTheDocument();
    });
  });

  it("adds upload links to the composer draft", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.ComposerUploadPopover]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    await screen.findByPlaceholderText(PLACEHOLDER);
    const editor = await findComposerEditor();
    const composer = composerElementFrom(editor);

    await user.click(within(composer).getByTestId("composer-upload"));
    await expect(
      screen.findByText("Upload from computer"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Upload from link")).toBeInTheDocument();

    await user.type(
      screen.getByTestId("composer-upload-link-input"),
      "https://example.com/image.png",
    );
    await user.click(screen.getByTestId("composer-upload-link-add"));

    await waitFor(() => {
      expect(editor.textContent).toBe("https://example.com/image.png");
    });
  });

  it("opens the template picker with responsive category navigation", async () => {
    const user = userEvent.setup({ delay: null });
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const videoTemplate = VIDEO_TEMPLATE_ITEMS[0]!;
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

    expect(tabByText("Presentation")).toBeInTheDocument();
    expect(tabByText("Illustration")).toBeInTheDocument();
    expect(tabByText("Video")).toBeInTheDocument();
    expect(tabByText("Website")).toBeInTheDocument();
    expect(document.activeElement).not.toBe(tabByText("Presentation"));
    expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
    expect(tabByText("Presentation")).toHaveClass("bg-gray-200");
    expect(tabByText("Presentation")).toHaveClass("font-medium");
    expect(tabByText("Presentation")).toHaveClass("text-sidebar-foreground");
    expect(tabByText("Illustration")).toHaveClass("text-sidebar-foreground");
    expect(tabByText("Illustration")).not.toHaveClass("bg-gray-200");
    const categorySelect = screen.getByRole("combobox", {
      name: "Template category",
    });
    expect(categorySelect).toBeInTheDocument();

    const categorySidebar = screen.getByRole("tablist", {
      name: "Template categories",
    });
    expect(categorySidebar).toBeInstanceOf(HTMLElement);
    expect(categorySidebar).toHaveAttribute("aria-orientation", "vertical");
    expect(categorySidebar).toHaveClass("hidden");
    expect(categorySidebar).toHaveClass("sm:flex");
    expect(categorySidebar).toHaveClass("bg-gray-50");

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
      expect(screen.getByLabelText("Search connectors")).toBeInTheDocument();
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

  it("selects a presentation template from the picker", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await openTemplatePicker(user, template);

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Remove template ${template.title}`),
      ).toBeInTheDocument();
    });
    await expectTemplateAttachedToComposer(`Remove template ${template.title}`);

    click(screen.getByLabelText(`Remove template ${template.title}`));

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("activates an embedded template control with Enter without sending the draft", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await selectTemplate(user, template);
    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("Keep this draft");

    const removeTemplate = screen.getByLabelText(
      `Remove template ${template.title}`,
    );
    removeTemplate.focus();
    expect(removeTemplate).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
      expect(editor).toHaveTextContent("Keep this draft");
    });
  });

  it("keeps a selected template attached when replacing all prompt text", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    let submittedPrompt: string | undefined;
    let submittedTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate: (body) => {
        submittedPrompt = body.prompt;
        submittedTemplate = body.generationTemplate;
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await selectTemplate(user, template);
    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("Initial prompt");
    await fill(editor, "Replacement prompt");

    await waitFor(() => {
      expect(
        editor.querySelectorAll("[data-composer-template-attachment]"),
      ).toHaveLength(1);
      expect(editor).toHaveTextContent("Replacement prompt");
      expect(editor).not.toHaveTextContent("Initial prompt");
    });

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(submittedPrompt).toBe("Replacement prompt");
      expect(submittedTemplate).toMatchObject({
        type: "presentation",
        selection: { templateId: template.templateId },
      });
      expect(
        editor.querySelectorAll("[data-composer-template-attachment]"),
      ).toHaveLength(0);
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the draft visible while send waits for draft attachments", async () => {
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
    await sendMessageInUI(user, editor, "Use this");

    expect(editor).toHaveTextContent("Use this");
    expect(
      screen.getByLabelText("Cancel upload launch-notes.txt"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(`Remove template ${template.title}`),
    ).toBeInTheDocument();
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
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn((blob: Blob) => {
      blobHtml.push(blob.text());
      return `blob:template-preview-${String(blobHtml.length)}`;
    });
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
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
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

    try {
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
        expect(currentPrismPreviewFrame()).toHaveAttribute(
          "data-loaded",
          "true",
        );
      });
      click(screen.getByLabelText("Close"));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(revokeObjectURL).toHaveBeenCalledWith(prismFrameUrl);
    } finally {
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: originalCreateObjectURL,
        });
      } else {
        delete (URL as { createObjectURL?: unknown }).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: originalRevokeObjectURL,
        });
      } else {
        delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      }
    }
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
    const previewFetch = createDeferredPromise<Response>(AbortSignal.any([]));
    const blobHtml: Promise<string>[] = [];
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn((blob: Blob) => {
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
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
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

    try {
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
          htmlForFrame(
            screen.getByTestId(`${template.title} card HTML preview`),
          ),
        ).resolves.toContain("Slide 15");
      });
    } finally {
      if (!previewFetch.settled()) {
        previewFetch.reject(new Error("Preview fetch intentionally cancelled"));
      }
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: originalCreateObjectURL,
        });
      } else {
        delete (URL as { createObjectURL?: unknown }).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: originalRevokeObjectURL,
        });
      } else {
        delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      }
    }
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
        if (body.generationTemplate?.type === "presentation") {
          selectedColorSystemId =
            body.generationTemplate.selection.colorSystemId;
        }
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
      within(templateDialog).getByLabelText("Select style Prism"),
    );
    expect(
      within(templateDialog).getByLabelText("Select style Prism"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      context.store.get(templateCardThemeIdBySlug$)[template.slug],
    ).toBeUndefined();

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

    await user.click(
      within(templateDialog).getByLabelText(
        `Select template ${template.title}`,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.getByLabelText(`Remove template ${template.title}`),
      ).toBeInTheDocument();
    });
    expect(context.store.get(templateCardThemeIdBySlug$)).toMatchObject({
      [template.slug]: "prism",
    });

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

    await sendMessageInUI(
      user,
      (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement,
      "Create a launch deck",
    );
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
    const previewFetch = createDeferredPromise<Response>(AbortSignal.any([]));
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

    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const blobHtml: Promise<string>[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobHtml.push(blob.text());
      return `blob:detail-theme-preview-${String(blobHtml.length)}`;
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    try {
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
      expect(
        firstThumbnail().parentElement?.querySelector("img"),
      ).not.toBeNull();
      expect(
        secondThumbnail().parentElement?.querySelector("img"),
      ).not.toBeNull();

      await user.click(
        within(templateDialog).getByLabelText("Select style Prism"),
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
          templateDialog.querySelector(
            '[data-template-detail-frame="previous"]',
          ),
        ).not.toBeInTheDocument();
      });
      expect(revokeObjectURL).toHaveBeenCalledWith(initialFrameSrc);

      const themedFrameSrc = frame().getAttribute("src");
      if (themedFrameSrc === null) {
        throw new Error("Themed detail preview frame URL not found");
      }
      const match = /^blob:detail-theme-preview-(\d+)$/.exec(themedFrameSrc);
      if (match === null) {
        throw new Error(
          `Unexpected detail preview frame URL: ${themedFrameSrc}`,
        );
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
    } finally {
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: originalCreateObjectURL,
        });
      } else {
        delete (URL as { createObjectURL?: unknown }).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: originalRevokeObjectURL,
        });
      } else {
        delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      }
    }
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
    const defaultThemeLabel = (
      template.colorSystemId ?? "color-system:warm-sand"
    )
      .replace("color-system:", "")
      .replace(/-/g, " ");
    expect(
      within(templateDialog).getByLabelText(
        new RegExp(`^Select style ${defaultThemeLabel}$`, "i"),
      ),
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
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove template ${template.title}`),
      ).toBeInTheDocument();
    });
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
    const animationFrame = createDeferredPromise<void>(AbortSignal.any([]));
    window.requestAnimationFrame(() => {
      animationFrame.resolve();
    });
    try {
      await animationFrame.promise;
    } finally {
      if (!animationFrame.settled()) {
        animationFrame.reject(new Error("Animation frame cancelled"));
      }
    }
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
    const previewFetch = createDeferredPromise<Response>(AbortSignal.any([]));
    let previewFetchCount = 0;
    const blobHtml: Promise<string>[] = [];
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        blobHtml.push(blob.text());
        return `blob:template-detail-${String(blobHtml.length)}`;
      }),
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
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
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

    try {
      detachedSetupPage({
        context,
        path: `/chats/${THREAD_ID}`,
      });

      click(
        await waitFor(() => {
          return screen.getByLabelText("Template");
        }),
      );
      click(
        screen.getByLabelText(`Preview ${template.title} at current slide`),
      );

      await waitFor(() => {
        expect(previewFetchCount).toBe(1);
        expect(
          screen.queryByTestId(`${template.title} detail HTML preview`),
        ).not.toBeInTheDocument();
      });

      const templateButton = queryAllByRoleFast("button").find((candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      });
      if (!templateButton) {
        throw new Error("Template button not found");
      }
      click(templateButton);
      click(
        screen.getByLabelText(`Preview ${template.title} at current slide`),
      );

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
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(
        "blob:template-detail-1",
      );
    } finally {
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: originalCreateObjectURL,
        });
      } else {
        delete (URL as { createObjectURL?: unknown }).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: originalRevokeObjectURL,
        });
      } else {
        delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      }
    }
  });

  it("navigates presentation template detail previews from the main preview", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
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

    const templateDialog = screen.getByRole("dialog");
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
    expect(screen.getByLabelText("Select style Carnival")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    click(screen.getByLabelText("Select style Prism"));
    expect(screen.getByLabelText("Select style Prism")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(templateDialog)
        .getByLabelText("Preview slide 1")
        .querySelector("iframe"),
    ).toBeNull();
    const prismSlidePreviewButton =
      within(templateDialog).getByLabelText("Preview slide 1");
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
    expect(screen.getByLabelText("Select style Carnival")).toHaveAttribute(
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

    const themeButton = screen.getByLabelText("Select style Carnival");
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

  it("selects and removes an illustration style from the picker", async () => {
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
    const card = screen.getByAltText(heroAlt).closest<HTMLElement>("div.group");
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

    expect(screen.queryByLabelText("Search connectors")).toBeNull();
    click(
      screen.getByLabelText(`Select template ${illustrationTemplate.title}`),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove template ${illustrationTemplate.title}`),
      ).toBeInTheDocument();
    });
    await expectTemplateAttachedToComposer(
      `Remove template ${illustrationTemplate.title}`,
    );

    click(
      screen.getByLabelText(`Remove template ${illustrationTemplate.title}`),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(
          `Remove template ${illustrationTemplate.title}`,
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("scrolls illustration thumbnails only after clicking a variant thumbnail", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.previewImages.length >= 4;
    });
    if (!illustrationTemplate) {
      throw new Error("Illustration template with four variants not found");
    }
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
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

    const card = screen.getByAltText(heroAlt).closest<HTMLElement>("div.group");
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
      .closest<HTMLElement>("div.group");
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

    try {
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
        const previewRoot = previewVideo.closest(
          "[data-video-template-preview]",
        );
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
    } finally {
      playSpy.mockRestore();
      pauseSpy.mockRestore();
    }
  });

  it("queues a selected template during an active run and clears the picker state", async () => {
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
    const queuedComposer = await screen.findByRole("textbox", {
      name: "Message",
    });
    await sendMessageInUI(user, queuedComposer, "Queue a matching deck");

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Queue a matching deck",
      );
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("clears a recalled template after queueing the message again", async () => {
    const user = userEvent.setup({ delay: null });
    const template = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const generationTemplate = {
      type: "illustration",
      selection: {
        illustrationStyleId: template.illustrationStyleId,
      },
    } satisfies GenerationTemplateRequest;
    let queuedGenerationTemplate: GenerationTemplateRequest | undefined;
    let queuedUserMessageTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-template-active-user",
          role: "user",
          content: "Start an active illustration run",
          runId: "run-template-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-template-active-assistant",
          role: "assistant",
          content: null,
          runId: "run-template-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-template-queued-user",
          role: "user",
          content: "invalidate",
          runId: undefined,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "template",
                titleSnapshot: template.title,
                template: generationTemplate,
              },
              { type: "text", text: "Queue a recalled illustration" },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      activeRunIds: ["run-template-active"],
      onQueuedMessageAppend: (body) => {
        queuedGenerationTemplate = body.generationTemplate;
        const templatePart = body.userMessage?.parts.find((part) => {
          return part.type === "template";
        });
        queuedUserMessageTemplate =
          templatePart?.type === "template" ? templatePart.template : undefined;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.StructuredPrompt]: true,
      },
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Queue a recalled illustration",
      );
    });

    click(screen.getByLabelText("Remove queued message"));

    const composer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => {
      expect(composer).toHaveTextContent("Queue a recalled illustration");
      expect(
        screen.getByLabelText(`Remove template ${template.title}`),
      ).toBeInTheDocument();
    });

    await user.click(composer);
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Queue a recalled illustration",
      );
      expect(queuedGenerationTemplate).toStrictEqual(generationTemplate);
      expect(queuedUserMessageTemplate).toStrictEqual(generationTemplate);
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps newer template selections visible after a queued template is sent", async () => {
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
    await sendMessageInUI(
      user,
      await screen.findByRole("textbox", { name: "Message" }),
      "Queue a matching deck",
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Queue a matching deck",
      );
    });

    await selectIllustrationTemplate(user, nextTemplate);

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove template ${nextTemplate.title}`),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("selects and removes a video template from the picker", async () => {
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

    expect(screen.queryByLabelText("Search connectors")).toBeNull();
    click(screen.getByLabelText(`Select video template ${videoStyle.title}`));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove video template ${videoStyle.title}`),
      ).toBeInTheDocument();
    });
    await expectTemplateAttachedToComposer(
      `Remove video template ${videoStyle.title}`,
    );

    click(screen.getByLabelText(`Remove video template ${videoStyle.title}`));

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove video template ${videoStyle.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("selects and sends a workflow template from the picker", async () => {
    const user = userEvent.setup({ delay: null });
    const workflowTemplate = WORKFLOW_TEMPLATE_ITEMS[0]!;
    let submittedTemplate: GenerationTemplateRequest | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate: (body) => {
        submittedTemplate = body.generationTemplate;
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

    expect(screen.getByLabelText("Search connectors")).toHaveAttribute(
      "placeholder",
      "Search connector...",
    );
    await fill(screen.getByLabelText("Search connectors"), "no workflow match");
    await waitFor(() => {
      expect(screen.getByText("No matches")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search connectors"), "auto-inbox");
    click(
      screen.getByLabelText(
        `Select workflow template ${workflowTemplate.title}`,
      ),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(
          `Remove workflow template ${workflowTemplate.title}`,
        ),
      ).toBeInTheDocument();
    });
    await expectTemplateAttachedToComposer(
      `Remove workflow template ${workflowTemplate.title}`,
    );

    const editor = await findComposerEditor();
    await sendMessageInUI(user, editor, "Create this inbox workflow");

    await waitFor(() => {
      expect(submittedTemplate).toStrictEqual({
        type: "workflow",
        selection: { workflowTemplateId: workflowTemplate.id },
      });
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(
          `Remove workflow template ${workflowTemplate.title}`,
        ),
      ).not.toBeInTheDocument();
    });
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
        submittedTemplate = body.generationTemplate;
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
    expect(screen.queryByLabelText("Search connectors")).toBeNull();
    click(
      screen.getByLabelText(`Select website template ${websiteTemplate.title}`),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(
          `Remove website template ${websiteTemplate.title}`,
        ),
      ).toBeInTheDocument();
    });
    await expectTemplateAttachedToComposer(
      `Remove website template ${websiteTemplate.title}`,
    );

    click(
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
    const websitePreviewPlaceholder = screen.getByTitle(
      `${websiteTemplate.title} website preview placeholder`,
    );
    expect(websitePreviewDialog).toHaveClass("data-[state=open]:!animate-none");
    expect(document.querySelector(".zero-dialog-overlay")).toHaveClass(
      "data-[state=open]:!animate-none",
    );
    expect(websitePreviewPlaceholder).toHaveClass("block");
    fireEvent.load(
      screen.getByTitle(`${websiteTemplate.title} website full preview`),
    );
    await waitFor(() => {
      expect(websitePreviewPlaceholder).toHaveClass("hidden");
    });
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
    ).toHaveClass("data-[state=open]:!animate-none");
    expect(document.querySelector(".zero-dialog-overlay")).toHaveClass(
      "data-[state=open]:!animate-none",
    );
    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    const editor = await findComposerEditor();
    await sendMessageInUI(user, editor, "Create a warm website");

    await waitFor(() => {
      expect(submittedTemplate).toStrictEqual({
        type: "website",
        selection: { websiteTemplateId: websiteTemplate.id },
      });
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(
          `Remove website template ${websiteTemplate.title}`,
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("reopens the picker on the presentation tab from the selected chip", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await selectTemplate(user, template);

    click(await screen.findByLabelText(`Preview template ${template.title}`));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(tabByText("Presentation")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("reopens on the illustration tab from the chip after the last-used tab changed", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    // Select an illustration style, which leaves the picker on the
    // Illustration tab.
    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Illustration")).toBeInTheDocument();
    });
    click(tabByText("Illustration"));
    click(
      await screen.findByLabelText(
        `Select template ${illustrationTemplate.title}`,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.getByLabelText(`Remove template ${illustrationTemplate.title}`),
      ).toBeInTheDocument();
    });

    // Move the last-used tab back to Presentation, then close without changing
    // the selection so the persisted tab no longer matches the selection.
    click(screen.getByLabelText("Template"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    click(tabByText("Presentation"));
    await waitFor(() => {
      expect(tabByText("Presentation")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Clicking the chip reopens on the tab matching the selection's type.
    click(
      screen.getByLabelText(`Preview template ${illustrationTemplate.title}`),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(tabByText("Illustration")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("removes the selected template from the chip without opening the picker", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await selectTemplate(user, template);

    click(screen.getByLabelText(`Remove template ${template.title}`));

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(`Preview template ${template.title}`),
    ).not.toBeInTheDocument();
  });
});
