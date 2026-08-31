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

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

function installRecordingMocks(options?: {
  readonly getUserMedia?: () => Promise<MediaStream>;
}) {
  const displayTrackStop = vi.fn<() => void>();
  const displayTrack = Object.assign(new EventTarget(), {
    stop: displayTrackStop,
  }) as unknown as MediaStreamTrack;
  const displayStream = {
    getAudioTracks: () => {
      return [];
    },
    getTracks: () => {
      return [displayTrack];
    },
    getVideoTracks: () => {
      return [displayTrack];
    },
  } as unknown as MediaStream;
  const recorderStarted = context.mocks.deferred<void>();
  const getUserMediaCalled = context.mocks.deferred<void>();
  let displayRequestedAt = 0;
  const getDisplayMedia = vi.fn<() => Promise<MediaStream>>(() => {
    displayRequestedAt = performance.now();
    return Promise.resolve(displayStream);
  });
  const openUserMedia =
    options?.getUserMedia ??
    (() => {
      return Promise.resolve(displayStream);
    });
  const getUserMedia = vi.fn<() => Promise<MediaStream>>(async () => {
    if (!getUserMediaCalled.settled()) {
      getUserMediaCalled.resolve(undefined);
    }
    return await openUserMedia();
  });
  const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia, getUserMedia },
  });

  let startCount = 0;
  let startElapsedMs = 0;
  class TestMediaRecorder extends EventTarget {
    static isTypeSupported(): boolean {
      return true;
    }

    readonly mimeType = "video/webm";
    state: RecordingState = "inactive";

    start(): void {
      this.state = "recording";
      startCount += 1;
      startElapsedMs = performance.now() - displayRequestedAt;
      if (!recorderStarted.settled()) {
        recorderStarted.resolve(undefined);
      }
    }

    stop(): void {
      this.state = "inactive";
      this.dispatchEvent(new Event("stop"));
    }
  }

  const mediaRecorderDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "MediaRecorder",
  );
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: TestMediaRecorder,
  });
  const playSpy = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue();
  const srcObjectDescriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "srcObject",
  );
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    writable: true,
    value: null,
  });

  context.signal.addEventListener(
    "abort",
    () => {
      playSpy.mockRestore();
      restoreProperty(
        HTMLMediaElement.prototype,
        "srcObject",
        srcObjectDescriptor,
      );
      restoreProperty(navigator, "mediaDevices", mediaDevicesDescriptor);
      restoreProperty(globalThis, "MediaRecorder", mediaRecorderDescriptor);
    },
    { once: true },
  );

  return {
    displayTrack,
    displayTrackStop,
    getDisplayMedia,
    getUserMedia,
    getUserMediaCalled: getUserMediaCalled.promise,
    recorderStarted: recorderStarted.promise,
    startElapsedMs: () => {
      return startElapsedMs;
    },
    startCount: () => {
      return startCount;
    },
  };
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
      '[data-intro-video-document-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video document input");
    }
    await user.upload(
      fileInput,
      new File(["deck"], "launch.pdf", { type: "application/pdf" }),
    );

    await expect(
      screen.findByText("Your source is ready"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Choose an avatar"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Skip avatar")).toBeNull();
    expect(dialog.querySelector("[data-avatar-catalog-toolbar]")).toHaveClass(
      "w-auto",
      "justify-start",
    );
    click(await screen.findByLabelText("Select template Alex"));
    expect(
      screen.getByText("How would you like the visual balance?"),
    ).toBeInTheDocument();
    const avatarLed = buttonWithText(
      "Avatar-led — narrator on screen most of the time",
      dialog,
      false,
    );
    const bRollLed = buttonWithText(
      "B-roll-led — focus on slides and visuals",
      dialog,
      false,
    );
    const balanced = buttonWithText(
      "Balanced mix — equal time for both",
      dialog,
    );
    expect(avatarLed).toHaveAttribute("aria-pressed", "false");
    expect(bRollLed).toHaveAttribute("aria-pressed", "false");
    expect(balanced).toHaveAttribute("aria-pressed", "true");
    click(avatarLed);
    expect(avatarLed).toHaveAttribute("aria-pressed", "true");
    expect(balanced).toHaveAttribute("aria-pressed", "false");
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
    expect(
      screen.queryByText("How would you like the visual balance?"),
    ).toBeNull();
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
      expect(sentPrompt).toContain("- Avatar: Alex (1)");
      expect(sentPrompt).toContain("- Voice: No voiceover");
      expect(sentPrompt).toContain(
        "- Visual balance: Avatar-led (presenter on screen most of the time)",
      );
      expect(sentUserMessage?.parts).toContainEqual({
        type: "file",
        fileId: "intro-video-source",
        filenameSnapshot: "launch.pdf",
        contentType: "application/pdf",
      });
    });
  });

  it("reattaches the source when chat creation is retried", async () => {
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
      '[data-intro-video-document-input=""]',
    );
    if (!fileInput) {
      throw new Error("Expected intro video document input");
    }
    await user.upload(
      fileInput,
      new File(["deck"], "launch.pdf", { type: "application/pdf" }),
    );
    await screen.findByText("Your source is ready");
    click(buttonWithText("Next", dialog));
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
    const newChatLink = queryAllByRoleFast("link").find((link) => {
      return (
        link.getAttribute("aria-label") === "New chat" &&
        link.getAttribute("href") === "/"
      );
    });
    if (!newChatLink) {
      throw new Error("Expected the new chat navigation link");
    }
    click(newChatLink);
    const retryDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    expect(
      screen.getByText(
        "The chat thread could not be created. Your source is still saved locally and has been downloaded as a backup.",
      ),
    ).toBeInTheDocument();
    await expect(
      screen.findByText("Review your intro video"),
    ).resolves.toBeInTheDocument();

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

  it("starts the intro video workflow directly in chat", async () => {
    mockChatLifecycle(context);
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));

    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    click(buttonWithText("Start in chat", dialog, false));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Create an intro video" }),
      ).not.toBeInTheDocument();
    });
    await expect(screen.findByLabelText("Stop")).resolves.toBeInTheDocument();
  });

  it("starts screen recording only after the three-second countdown", async () => {
    mockChatLifecycle(context);
    const recording = installRecordingMocks();
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));
    const recordingDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    click(buttonWithText("Record your screen", recordingDialog, false));
    click(buttonWithText("Choose screen and start", recordingDialog));

    await waitFor(() => {
      expect(recording.getDisplayMedia).toHaveBeenCalledTimes(1);
    });
    const countdownCopy = await screen.findByText(
      "Recording starts after the countdown",
    );
    expect(countdownCopy.parentElement).toHaveTextContent("3");
    expect(recording.startCount()).toBe(0);

    await recording.recorderStarted;
    expect(recording.startElapsedMs()).toBeGreaterThanOrEqual(2900);
    expect(recording.startCount()).toBe(1);

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Create an intro video" }),
      ).not.toBeInTheDocument();
    });
    click(screen.getByTestId("intro-video-start-card"));
    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    expect(
      buttonWithText("Choose screen and start", reopenedDialog),
    ).toBeInTheDocument();
    click(screen.getByLabelText("Close"));
  });

  it("resets screen recording after navigating away during countdown", async () => {
    mockChatLifecycle(context);
    const recording = installRecordingMocks();
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));
    const recordingDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    click(buttonWithText("Record your screen", recordingDialog, false));
    click(buttonWithText("Choose screen and start", recordingDialog));

    await expect(
      screen.findByText("Recording starts after the countdown"),
    ).resolves.toBeInTheDocument();
    const agentsLink = await waitFor(() => {
      const link = document.querySelector('a[href="/agents"]');
      expect(link).not.toBeNull();
      return link as HTMLElement;
    });
    click(agentsLink);

    await expect(
      screen.findByRole("heading", { name: "Agents" }),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(recording.displayTrackStop).toHaveBeenCalledWith();
    });

    act(() => {
      window.history.back();
    });
    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByTestId("intro-video-start-card"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Create an intro video" }),
    ).not.toBeInTheDocument();

    click(screen.getByTestId("intro-video-start-card"));
    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    expect(
      buttonWithText("Choose screen and start", reopenedDialog),
    ).toBeInTheDocument();
    click(screen.getByLabelText("Close"));
  });

  it("releases late microphone access after the recording dialog closes", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    const microphonePermission = context.mocks.deferred<MediaStream>();
    const microphoneTrackStop = vi.fn<() => void>();
    const microphoneTrack = Object.assign(new EventTarget(), {
      stop: microphoneTrackStop,
    }) as unknown as MediaStreamTrack;
    const microphoneStream = {
      getAudioTracks: () => {
        return [microphoneTrack];
      },
      getTracks: () => {
        return [microphoneTrack];
      },
      getVideoTracks: () => {
        return [];
      },
    } as unknown as MediaStream;
    const recording = installRecordingMocks({
      getUserMedia: () => {
        return microphonePermission.promise;
      },
    });
    setupChatStartCards();

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));
    const recordingDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    click(buttonWithText("Record your screen", recordingDialog, false));
    const microphoneSwitch = screen.getByRole("switch", {
      name: /Microphone/,
    });
    await user.click(microphoneSwitch);
    expect(microphoneSwitch).toHaveAttribute("aria-checked", "true");
    click(buttonWithText("Choose screen and start", recordingDialog));

    await recording.getUserMediaCalled;
    expect(recording.getUserMedia).toHaveBeenCalledTimes(1);
    click(screen.getByLabelText("Close"));
    microphonePermission.resolve(microphoneStream);

    await waitFor(() => {
      expect(recording.displayTrackStop).toHaveBeenCalledWith();
      expect(microphoneTrackStop).toHaveBeenCalledWith();
    });
    click(screen.getByTestId("intro-video-start-card"));
    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    expect(
      buttonWithText("Choose screen and start", reopenedDialog),
    ).toBeInTheDocument();
    click(screen.getByLabelText("Close"));
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
