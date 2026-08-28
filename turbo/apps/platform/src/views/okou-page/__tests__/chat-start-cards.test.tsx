import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WORKFLOW_TEMPLATE_ITEMS } from "@okouai/core/workflow-template-items";
import { describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { buildIntroVideoPrompt } from "../../../signals/okou-page/intro-video.ts";
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

describe("chat start cards", () => {
  it("draws three catalog entries and the intro video flow", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

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
  });

  it("uploads an intro video source and creates its chat thread", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);
    context.mocks.upload.success({
      id: "intro-video-source",
      filename: "launch.pdf",
      contentType: "application/pdf",
      size: 4,
      url: "https://example.com/launch.pdf",
    });

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
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
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Choose a voice"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("No voiceover", dialog, false));
    click(buttonWithText("Next", dialog));
    await expect(
      screen.findByText("Review your intro video"),
    ).resolves.toBeInTheDocument();
    click(buttonWithText("Create in chat", dialog));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Create an intro video" }),
      ).not.toBeInTheDocument();
    });
    await expect(screen.findByLabelText("Stop")).resolves.toBeInTheDocument();
  });

  it("starts the intro video workflow directly in chat", async () => {
    mockChatLifecycle(context);
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

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

  it("builds the configured intro video prompt for chat", () => {
    const prompt = buildIntroVideoPrompt({
      aspectRatio: "landscape",
      avatar: null,
      instructions: "Keep the pacing focused.",
      source: {
        blob: new Blob(["deck"], { type: "application/pdf" }),
        contentType: "application/pdf",
        durationSeconds: null,
        kind: "document",
        name: "launch.pdf",
        previewUrl: null,
        size: 4,
      },
      voice: { kind: "none" },
    });

    expect(prompt).toContain(
      "Create a polished intro video from the attached source.",
    );
    expect(prompt).toContain("- Source: launch.pdf");
    expect(prompt).toContain("- Avatar: No avatar");
    expect(prompt).toContain("- Voice: No voiceover");
    expect(prompt).toContain("Keep the pacing focused.");
  });

  it("starts screen recording only after the three-second countdown", async () => {
    mockChatLifecycle(context);
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    await expect(
      screen.findByPlaceholderText(PLACEHOLDER),
    ).resolves.toBeInTheDocument();
    click(screen.getByTestId("intro-video-start-card"));
    const recordingDialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    click(buttonWithText("Record your screen", recordingDialog, false));

    const displayTrack = Object.assign(new EventTarget(), {
      stop: vi.fn<() => void>(),
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
    const getDisplayMedia = vi.fn<() => Promise<MediaStream>>(() => {
      return Promise.resolve(displayStream);
    });
    const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "mediaDevices",
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia,
        getUserMedia: vi.fn<() => Promise<MediaStream>>(),
      },
    });

    class TestMediaRecorder extends EventTarget {
      static startCount = 0;
      static isTypeSupported(): boolean {
        return true;
      }

      readonly mimeType = "video/webm";
      state: RecordingState = "inactive";

      start(): void {
        this.state = "recording";
        TestMediaRecorder.startCount += 1;
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

    vi.useFakeTimers();
    try {
      click(buttonWithText("Choose screen and start", recordingDialog));
      await vi.advanceTimersByTimeAsync(0);
      expect(getDisplayMedia).toHaveBeenCalledTimes(1);
      expect(TestMediaRecorder.startCount).toBe(0);

      await vi.advanceTimersByTimeAsync(2999);
      expect(TestMediaRecorder.startCount).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(TestMediaRecorder.startCount).toBe(1);

      click(screen.getByLabelText("Close"));
      await vi.waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Create an intro video" }),
        ).not.toBeInTheDocument();
      });
    } finally {
      const closeButton = screen.queryByLabelText("Close");
      if (closeButton) {
        click(closeButton);
        await vi.advanceTimersByTimeAsync(0);
      }
      vi.useRealTimers();
      playSpy.mockRestore();
      if (srcObjectDescriptor) {
        Object.defineProperty(
          HTMLMediaElement.prototype,
          "srcObject",
          srcObjectDescriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLMediaElement.prototype, "srcObject");
      }
      if (mediaDevicesDescriptor) {
        Object.defineProperty(
          navigator,
          "mediaDevices",
          mediaDevicesDescriptor,
        );
      } else {
        Reflect.deleteProperty(navigator, "mediaDevices");
      }
      if (mediaRecorderDescriptor) {
        Object.defineProperty(
          globalThis,
          "MediaRecorder",
          mediaRecorderDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis, "MediaRecorder");
      }
    }
  });

  it("writes the card prompt into the composer", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

    const composer = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    expect(composer).toHaveTextContent("");

    click(screen.getAllByText("Create")[0]);

    expect(composer.textContent).not.toBe("");
  });

  it("opens the template picker from a card", async () => {
    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

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

    detachedSetupPage({
      context,
      path: `/agents/${agentId}/chat`,
    });

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
