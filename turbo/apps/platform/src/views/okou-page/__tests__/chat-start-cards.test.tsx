import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { avatarVideoContract } from "@okouai/api-contracts/contracts/avatar-video";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { WORKFLOW_TEMPLATE_ITEMS } from "@okouai/core/workflow-template-items";
import { describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setupAgentChatPage$ } from "../../../signals/okou-page/agent-chat-page-setup.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle, PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

const agentId = "c0000000-0000-4000-a000-000000000001";

// The row draws 3 of 6 kinds at random, so only the workflow card can carry a
// catalog title. Everything else comes from these localized entries.
const EN_TITLES = [
  "Create a presentation",
  "Build a website",
  "Create an illustration",
  "Create a video",
  "Create an avatar",
] as const;
const PT_BR_TITLES = [
  "Criar uma apresentação",
  "Criar um site",
  "Criar uma ilustração",
  "Criar um vídeo",
  "Criar um avatar",
] as const;
// The catalog's own English wording, which only en-US readers should see.
const EN_WORKFLOW_TITLES = WORKFLOW_TEMPLATE_ITEMS.map((item) => {
  return item.title;
});
const PT_BR_PLACEHOLDER =
  "Peça para automatizar fluxos de trabalho, gerenciar tarefas...";

function startCards(): readonly HTMLElement[] {
  return [
    ...screen.getByTestId("start-cards").querySelectorAll(".zero-card"),
  ].filter((element): element is HTMLElement => {
    return element instanceof HTMLElement;
  });
}

function templateButtons(): readonly HTMLElement[] {
  return queryAllByRoleFast("button", screen.getByTestId("start-cards")).filter(
    (element) => {
      return element.textContent?.trim() === "Templates";
    },
  );
}

function buttonWithText(
  text: string,
  container: ParentNode = document.body,
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

function renderedTitles(titles: readonly string[]): readonly string[] {
  return titles.filter((title) => {
    return screen.queryByText(title) !== null;
  });
}

function setupChatStartCards(introVideo = true): void {
  detachedSetupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: introVideo },
  });
}

describe("chat start cards", () => {
  it("draws three catalog entries and the intro video flow", async () => {
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    expect(startCards()).toHaveLength(4);
    // At most one of the three kinds is the workflow card, so at least two
    // titles always come from the localized catalog.
    expect(renderedTitles(EN_TITLES).length).toBeGreaterThanOrEqual(2);
    expect(
      renderedTitles(EN_TITLES).length +
        renderedTitles(EN_WORKFLOW_TITLES).length,
    ).toBe(3);
    expect(screen.getAllByText("Create")).toHaveLength(3);
    expect(templateButtons()).toHaveLength(3);
    expect(screen.getByText("Create an intro video")).toBeInTheDocument();
    expect(screen.getByTestId("start-cards")).toHaveClass("sm:grid-cols-2");
  });

  it("keeps the original start cards when intro video is disabled", async () => {
    setupChatStartCards(false);

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    expect(startCards()).toHaveLength(3);
    expect(screen.queryByTestId("intro-video-start-card")).toBeNull();
    expect(screen.getByTestId("start-cards")).toHaveClass(
      "sm:grid-cols-2",
      "lg:grid-cols-3",
    );
    expect(screen.getByTestId("start-cards")).not.toHaveClass("sm:grid-cols-3");
  });

  it("keeps a completed tagline visible when the same chat route is set up again", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    context.signal.addEventListener(
      "abort",
      () => {
        random.mockRestore();
      },
      { once: true },
    );
    setupChatStartCards();

    const tagline = await screen.findByTestId("chat-tagline");
    const expected = tagline.getAttribute("aria-label");
    if (!expected) {
      throw new Error("Expected an accessible chat tagline");
    }
    await waitFor(() => {
      expect(screen.getByTestId("chat-tagline").textContent).toBe(expected);
    });

    await act(async () => {
      await context.store.set(setupAgentChatPage$, context.signal);
    });

    expect(screen.getByTestId("chat-tagline").textContent).toBe(expected);
  });

  it("uploads an intro video source and creates its chat thread", async () => {
    const user = userEvent.setup({ delay: null });
    let sentPrompt: string | undefined;
    let sentUserMessage: UserMessageDocument | undefined;
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
    context.mocks.upload.success({
      id: "intro-video-source",
      filename: "launch.pdf",
      contentType: "application/pdf",
      size: 4,
      url: "https://example.com/launch.pdf",
    });
    context.mocks.api(avatarVideoContract.avatars, ({ respond }) => {
      return respond(200, {
        avatars: [{ id: 1, name: "Alex" }],
      });
    });
    context.mocks.api(avatarVideoContract.voices, ({ respond }) => {
      return respond(200, {
        voices: [
          {
            id: "en-US-RileyNeural",
            name: "Riley",
            sampleUrl: "https://example.com/riley.mp3",
            language: "English",
            gender: "female",
            age: "young",
            accent: "american",
            useCase: "advertisement",
          },
        ],
        hasMore: false,
        filterOptions: {
          languages: ["english"],
          useCases: ["advertisement"],
        },
      });
    });

    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    await screen.findByLabelText("Send");
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    const fileInput = dialog.querySelector<HTMLInputElement>(
      '[data-intro-video-presentation-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video presentation input");
    }
    await user.upload(
      fileInput,
      new File(["deck"], "launch.pdf", { type: "application/pdf" }),
    );

    // A deck the user just picked needs no second confirmation, so the wizard
    // moves straight to the presenter instead of a source review page.
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Your source is ready")).toBeNull();
    expect(screen.queryByText("Skip avatar")).toBeNull();
    // The wizard offers a curated cutout set instead of the paged JoggAI
    // catalog, so it has no aspect-ratio or catalog filter toolbar.
    expect(dialog.querySelector("[data-avatar-catalog-toolbar]")).toBeNull();
    expect(
      dialog.querySelector("[data-intro-video-avatar-grid]"),
    ).not.toBeNull();
    click(await screen.findByLabelText("Select template Amara"));
    expect(
      screen.getByText("Where should the presenter stand?"),
    ).toBeInTheDocument();
    const placementLeft = buttonWithText(
      "Left — the slide sits to the right",
      dialog,
    );
    const placementRight = buttonWithText(
      "Right — the slide sits to the left",
      dialog,
      false,
    );
    // The default is the left margin, so the deck never has to move for a
    // presenter the user has not positioned yet.
    expect(placementLeft).toHaveAttribute("aria-pressed", "true");
    expect(placementRight).toHaveAttribute("aria-pressed", "false");
    click(placementRight);
    expect(placementRight).toHaveAttribute("aria-pressed", "true");
    expect(placementLeft).toHaveAttribute("aria-pressed", "false");
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Choose a voice"),
    ).resolves.toBeInTheDocument();
    const recommendedVoice = await screen.findByLabelText("Select voice Riley");
    expect(recommendedVoice).toHaveClass(
      "border-primary/40",
      "bg-primary/[0.025]",
    );
    click(buttonWithText("No voiceover", dialog, false));
    expect(recommendedVoice).toHaveAttribute("aria-pressed", "false");
    expect(recommendedVoice).toHaveClass("border-border");
    expect(recommendedVoice).not.toHaveClass(
      "border-primary/40",
      "bg-primary/[0.025]",
    );
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Review your intro video"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Where should the presenter stand?")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Editing instructions" }),
    ).toHaveValue("");
    const createButton = buttonWithText("Create in chat", dialog);
    expect(createButton).toBeInTheDocument();
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Create an intro video" }),
      ).not.toBeInTheDocument();
    });
    await expect(screen.findByLabelText("Stop")).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(sentPrompt).toContain(
        "Create a polished intro video from the attached source.",
      );
      expect(sentPrompt).toContain("- Source: launch.pdf");
      expect(sentPrompt).toContain("- Avatar: Amara (1785)");
      expect(sentPrompt).toContain("- Aspect ratio: 16:9");
      expect(sentPrompt).toContain(
        "- Avatar cutout (transparent still): https://static.vm0.io/platform/avatars/intro-video/v1/1785.webp",
      );
      expect(sentPrompt).toContain(
        "- Avatar background: transparent WebM (JoggAI screen_style 3, which requires captions off)",
      );
      expect(sentPrompt).toContain("- Voice: No voiceover");
      expect(sentPrompt).toContain(
        "- Presenter placement: Presenter on the right, slide on the left",
      );
      expect(sentPrompt).toContain(
        "- Presenter scale: scale the cutout proportionally to 14% of the frame width and align its bottom edge with the slide's bottom edge, for every presenter and every page",
      );
      expect(sentPrompt).toContain("<intro_video_workflow>");
      // A deck is turned into slides and narrated, so it carries the document
      // workflow rather than the recording camera pass.
      expect(sentPrompt).toContain("- Source type: presentation");
      expect(sentPrompt).toContain("confirm it really is a paginated deck");
      expect(sentPrompt).toContain("okou presentation screenshot");
      expect(sentPrompt).not.toContain("okou video camera");
      expect(sentPrompt).not.toContain("Editing direction:");
      expect(sentUserMessage?.parts).toContainEqual({
        type: "file",
        fileId: "intro-video-source",
        filenameSnapshot: "launch.pdf",
        contentType: "application/pdf",
      });
      expect(JSON.stringify(sentUserMessage)).not.toContain(
        "<intro_video_workflow>",
      );
      expect(JSON.stringify(sentUserMessage)).not.toContain(
        "is a presentation",
      );
    });
  });

  it("sends an upload of unknown kind through the generic source workflow", async () => {
    const user = userEvent.setup({ delay: null });
    let sentPrompt: string | undefined;
    mockChatLifecycle(context, {
      onSendRequest: ({ prompt }) => {
        sentPrompt = prompt;
      },
      onRunCreate: ({ prompt }) => {
        sentPrompt = prompt;
      },
    });
    context.mocks.upload.success({
      id: "intro-video-source",
      filename: "launch.mov",
      contentType: "video/quicktime",
      size: 4,
      url: "https://example.com/launch.mov",
    });

    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    // The generic entry takes what the deck entry turns away, and says nothing
    // about what the file is.
    const fileInput = dialog.querySelector<HTMLInputElement>(
      '[data-intro-video-file-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video file input");
    }
    expect(fileInput).not.toHaveAttribute("accept");
    await user.upload(
      fileInput,
      new File(["take"], "launch.mov", { type: "video/quicktime" }),
    );

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
    await user.type(
      screen.getByRole("textbox", { name: "Editing instructions" }),
      "Keep the source's original pacing.",
    );
    await user.click(buttonWithText("Create in chat", dialog));

    await waitFor(() => {
      expect(sentPrompt).toContain("- Source type: file");
      expect(sentPrompt).toContain("open it and identify it first");
      expect(sentPrompt).toContain(
        "Editing direction:\nKeep the source's original pacing.",
      );
    });
    // Neither of the workflows that assume they already know the source.
    expect(sentPrompt).not.toContain("For an attached presentation source:");
    expect(sentPrompt).not.toContain(
      "For a screen recording with a synchronized",
    );
  });

  it("keeps placement out of the no-avatar intro video prompt", async () => {
    const user = userEvent.setup({ delay: null });
    let sentPrompt: string | undefined;
    mockChatLifecycle(context, {
      onSendRequest: ({ prompt }) => {
        sentPrompt = prompt;
      },
      onRunCreate: ({ prompt }) => {
        sentPrompt = prompt;
      },
    });
    context.mocks.upload.success({
      id: "intro-video-source",
      filename: "launch.pdf",
      contentType: "application/pdf",
      size: 4,
      url: "https://example.com/launch.pdf",
    });

    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    const fileInput = dialog.querySelector<HTMLInputElement>(
      '[data-intro-video-presentation-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video presentation input");
    }
    await user.upload(
      fileInput,
      new File(["deck"], "launch.pdf", { type: "application/pdf" }),
    );

    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();
    // Without a presenter the deck fills the frame on its own, so the
    // placement question is never asked.
    expect(screen.queryByText("Where should the presenter stand?")).toBeNull();

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
      expect(sentPrompt).toContain("- Avatar: No avatar");
      expect(sentPrompt).not.toContain("- Presenter placement:");
    });
  });

  it("can return to no presenter after picking one", async () => {
    const user = userEvent.setup({ delay: null });
    let sentPrompt: string | undefined;
    mockChatLifecycle(context, {
      onSendRequest: ({ prompt }) => {
        sentPrompt = prompt;
      },
      onRunCreate: ({ prompt }) => {
        sentPrompt = prompt;
      },
    });
    context.mocks.upload.success({
      id: "intro-video-source",
      filename: "launch.pdf",
      contentType: "application/pdf",
      size: 4,
      url: "https://example.com/launch.pdf",
    });

    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    const fileInput = dialog.querySelector<HTMLInputElement>(
      '[data-intro-video-presentation-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video presentation input");
    }
    await user.upload(
      fileInput,
      new File(["deck"], "launch.pdf", { type: "application/pdf" }),
    );
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();

    const noAvatar = dialog.querySelector<HTMLButtonElement>(
      '[data-intro-video-no-avatar=""]',
    );
    if (!noAvatar) {
      throw new Error("Expected a no-avatar card");
    }
    expect(noAvatar).toHaveAttribute("aria-pressed", "true");

    click(await screen.findByLabelText("Select template Amara"));
    expect(noAvatar).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText("Where should the presenter stand?"),
    ).toBeInTheDocument();

    // The wizard keeps its draft across close and reopen and the presenter
    // cards do not toggle off, so without this card a picked presenter could
    // never be undone.
    click(noAvatar);
    expect(noAvatar).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Where should the presenter stand?")).toBeNull();

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
      expect(sentPrompt).toContain("- Avatar: No avatar");
      expect(sentPrompt).not.toContain("- Presenter placement:");
    });
  });

  it("forgets everything when the wizard is closed", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    const fileInput = dialog.querySelector<HTMLInputElement>(
      '[data-intro-video-presentation-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video presentation input");
    }
    await user.upload(
      fileInput,
      new File(["deck"], "launch.pdf", { type: "application/pdf" }),
    );
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();
    click(await screen.findByLabelText("Select template Amara"));
    expect(
      screen.getByText("Where should the presenter stand?"),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Create an intro video" }),
      ).not.toBeInTheDocument();
    });

    click(screen.getByTestId("intro-video-start-card"));
    const reopened = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    // Closing discards the draft, so the wizard reopens on an empty source
    // step rather than resuming the deck and presenter from before.
    await expect(
      screen.findByText("How do you want to start?"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Your source is ready")).toBeNull();
    expect(screen.queryByText("launch.pdf")).toBeNull();
    // The later steps only unlock once a source exists, so a disabled Avatar
    // step is direct evidence the previous deck was dropped rather than the
    // wizard merely rewinding to step one.
    expect(buttonWithText("Avatar", reopened, false)).toBeDisabled();
    expect(buttonWithText("Voice", reopened, false)).toBeDisabled();

    const reopenedInput = reopened.querySelector<HTMLInputElement>(
      '[data-intro-video-presentation-input=""]',
    );
    if (!reopenedInput) {
      throw new Error("Expected intro video presentation input");
    }
    await user.upload(
      reopenedInput,
      new File(["deck"], "second.pdf", { type: "application/pdf" }),
    );
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();
    // And the presenter came back cleared, not still set to Amara.
    expect(
      reopened.querySelector('[data-intro-video-no-avatar=""]'),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Where should the presenter stand?")).toBeNull();
  });

  it("drops the deck when the presenter step is left behind", async () => {
    const user = userEvent.setup({ delay: null });
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    const fileInput = dialog.querySelector<HTMLInputElement>(
      '[data-intro-video-presentation-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video presentation input");
    }
    await user.upload(
      fileInput,
      new File(["deck"], "launch.pdf", { type: "application/pdf" }),
    );
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();

    click(buttonWithText("Back", dialog, false));

    // A deck has no review page to step back to, so leaving the presenter is
    // the user saying they picked the wrong file: it is thrown away and the
    // later steps lock again.
    await expect(
      screen.findByText("How do you want to start?"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(buttonWithText("Avatar", dialog, false)).toBeDisabled();
    });
    expect(buttonWithText("Voice", dialog, false)).toBeDisabled();
    expect(screen.queryByText("launch.pdf")).toBeNull();
  });

  it("sends screen recording to the desktop app", async () => {
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    click(buttonWithText("Record your screen", dialog, false));

    // The browser no longer records: the card explains the desktop handoff and
    // hands out the installer instead of asking Chrome to share a surface.
    await expect(
      screen.findByText("Start a recording from the menu bar"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("Come back to this wizard automatically"),
    ).toBeInTheDocument();
    // The installer link only replaces the compatibility placeholder once the
    // architecture check settles.
    const download = await waitFor(() => {
      const link = queryAllByRoleFast("link", dialog).find((element) => {
        return element.textContent?.trim() === "Download for macOS";
      });
      if (!link) {
        throw new Error("Expected the desktop download link");
      }
      return link;
    });
    expect(download).toHaveAttribute(
      "href",
      expect.stringContaining("/api/desktop/updates/stable/darwin/arm64/dmg"),
    );

    click(buttonWithText("Back", dialog, false));
    await expect(
      screen.findByText("How do you want to start?"),
    ).resolves.toBeInTheDocument();
  });

  it("restores the source in a fresh wizard when chat creation is retried", async () => {
    const user = userEvent.setup({ delay: null });
    const downloads = context.mocks.browser.blobDownload();
    let sentUserMessage: UserMessageDocument | undefined;
    let failNextSend = true;
    mockChatLifecycle(context, {
      sendGate: () => {
        if (!failNextSend) {
          return Promise.resolve();
        }
        failNextSend = false;
        return Promise.reject(new Error("Try again"));
      },
      onSendRequest: ({ userMessage }) => {
        sentUserMessage = userMessage;
      },
      onRunCreate: ({ userMessage }) => {
        sentUserMessage = userMessage;
      },
    });
    context.mocks.upload.success({
      id: "intro-video-source",
      filename: "launch.pdf",
      contentType: "application/pdf",
      size: 4,
      url: "https://example.com/launch.pdf",
    });
    context.mocks.api(avatarVideoContract.voices, ({ respond }) => {
      return respond(200, {
        voices: [],
        hasMore: false,
        filterOptions: { languages: [], useCases: [] },
      });
    });
    setupChatStartCards();
    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    await screen.findByLabelText("Send");
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    const fileInput = dialog.querySelector<HTMLInputElement>(
      '[data-intro-video-presentation-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video presentation input");
    }
    await user.upload(
      fileInput,
      new File(["deck"], "launch.pdf", { type: "application/pdf" }),
    );
    await screen.findByText("Choose an avatar");
    click(buttonWithText("Next", dialog));
    await screen.findByText("Choose a voice");
    click(buttonWithText("No voiceover", dialog, false));
    click(buttonWithText("Next", dialog));
    await screen.findByText("Review your intro video");
    const createButton = buttonWithText("Create in chat", dialog);
    expect(createButton).toBeInTheDocument();
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    await waitFor(() => {
      expect(downloads.downloads).toHaveLength(1);
    });
    const newChatButton = queryAllByRoleFast("button").find((button) => {
      return (
        button.getAttribute("aria-label") === "New chat" &&
        button.querySelector(".lucide-square-pen") !== null
      );
    });
    if (!newChatButton) {
      throw new Error("Expected the new chat navigation button");
    }
    click(newChatButton);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Create an intro video" }),
      ).not.toBeInTheDocument();
    });
    click(await screen.findByTestId("intro-video-start-card"));
    const retryDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    expect(
      screen.queryByText(
        "The chat thread could not be created. Your source is still saved locally and has been downloaded as a backup.",
      ),
    ).not.toBeInTheDocument();
    // The stored draft comes back as the wizard's source, which lands on the
    // presenter just like a fresh pick does.
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("Next", retryDialog));
    await screen.findByText("Choose a voice");
    const noVoiceover = buttonWithText("No voiceover", retryDialog, false);
    expect(noVoiceover).toHaveAttribute("aria-pressed", "false");
    click(noVoiceover);
    click(buttonWithText("Next", retryDialog));
    await screen.findByText("Review your intro video");

    const retryCreateButton = buttonWithText("Create in chat", retryDialog);
    expect(retryCreateButton).toBeEnabled();
    await user.click(retryCreateButton);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Create an intro video" }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(sentUserMessage?.parts).toContainEqual({
        type: "file",
        fileId: "intro-video-source",
        filenameSnapshot: "launch.pdf",
        contentType: "application/pdf",
      });
    });
  });

  it("writes the card prompt into the composer", async () => {
    setupChatStartCards();

    const composer = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    expect(composer).toHaveTextContent("");

    click(screen.getAllByText("Create")[0]);

    expect(composer.textContent).not.toBe("");
  });

  it("opens the template picker from a card", async () => {
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    click(templateButtons()[0]);

    await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
  });

  it("localizes the entry cards", async () => {
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });
    context.mocks.data.onboardingStatus({ defaultAgentId: null });

    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PT_BR_PLACEHOLDER),
    ).resolves.toBeInTheDocument();

    expect(renderedTitles(PT_BR_TITLES).length).toBeGreaterThanOrEqual(2);
    expect(renderedTitles(EN_TITLES)).toStrictEqual([]);
    // The workflow card names a catalog template, which is localized too.
    expect(renderedTitles(EN_WORKFLOW_TITLES)).toStrictEqual([]);
    expect(screen.getAllByText("Modelos")).toHaveLength(3);
    expect(screen.queryByText("Templates")).toBeNull();
  });
});
