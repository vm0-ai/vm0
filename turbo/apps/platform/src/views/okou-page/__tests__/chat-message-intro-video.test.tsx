import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  introVideoPresenterContract,
  type IntroVideoAvatar,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { search } from "../../../signals/location.ts";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  context,
  findComposer,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const INTRO_VIDEO_SWITCHES = {
  [FeatureSwitchKey.IntroVideo]: true,
} as const;

const DESKTOP_HANDOFF_PARAMS = {
  "intro-video-recording": "video-upload-id",
  "intro-video-recording-name": "demo.mp4",
  "intro-video-recording-size": "1024",
  "intro-video-clicks": "events-upload-id",
  "intro-video-clicks-name": "demo.clicks.json",
  "intro-video-clicks-size": "512",
  "intro-video-user": "test-user-123",
} as const;

type MessageExperienceOptions = NonNullable<
  Parameters<typeof installMessageExperienceChat>[0]
>;

function installIntroVideoFixture(
  options: MessageExperienceOptions = {},
): void {
  installMessageExperienceChat(options);
  context.mocks.upload.success({
    id: "f0000000-0000-4000-a000-000000000051",
    filename: "launch.pdf",
    contentType: "application/pdf",
    size: 13,
    url: "https://files.example.test/launch.pdf",
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    expect(params.id).toBe(MESSAGE_EXPERIENCE_AGENT_ID);
    return respond(200, {
      agentId: MESSAGE_EXPERIENCE_AGENT_ID,
      ownerId: "test-user-123",
      description: null,
      displayName: "Message Agent",
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
  });
  context.mocks.api(
    introVideoPresenterContract.styles,
    ({ query, respond }) => {
      expect(query).toStrictEqual({ pageSize: 24 });
      return respond(200, {
        styles: [
          {
            id: "349d91e1ad2444eabab2672a9057f298",
            name: "Thriller",
            thumbnailUrl: "https://files.heygen.test/thriller.jpg",
            previewVideoUrl: "https://files.heygen.test/thriller.mp4",
            tags: ["cinematic"],
            aspectRatio: "16:9",
          },
        ],
        hasMore: false,
        nextToken: null,
      });
    },
  );
  context.mocks.api(
    introVideoPresenterContract.avatars,
    ({ query, respond }) => {
      expect(query).toStrictEqual({ pageSize: 24 });
      return respond(200, {
        avatars: [
          {
            id: "Daphne_public_1",
            groupId: "c1926d821b4d43d6a5f07f2985bb5cd1",
            name: "Daphne in Grey blazer",
            defaultVoiceId: "812d4eea4a8442a382dcaf2dbaddbd93",
            previewImageUrl: "https://files.heygen.test/daphne.webp",
            previewVideoUrl: "https://files.heygen.test/daphne.mp4",
            gender: "female",
            imageWidth: 1080,
            imageHeight: 1080,
            preferredOrientation: "portrait",
          },
        ],
        hasMore: false,
        nextToken: null,
      });
    },
  );
  context.mocks.api(
    introVideoPresenterContract.voices,
    ({ query, respond }) => {
      expect(query).toStrictEqual({ pageSize: 24 });
      return respond(200, {
        voices: [
          {
            id: "330290724a1b470fb63153f34d4c0183",
            name: "Annie - Lifelike",
            language: "English",
            gender: "female",
            sampleUrl: "https://files.heygen.test/annie.wav",
          },
        ],
        hasMore: false,
        nextToken: null,
      });
    },
  );
}

async function setupIntroVideoPage(path?: string): Promise<void> {
  await setupPage({
    context,
    path: path ?? `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    featureSwitches: INTRO_VIDEO_SWITCHES,
  });
}

async function openIntroVideoDialog(): Promise<HTMLElement> {
  click(await screen.findByTestId("intro-video-start-card"));
  return await screen.findByRole("dialog", {
    name: "Create an intro video",
  });
}

function requiredButtonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function mockCatalogIntersection() {
  const targets = new Map<Element, (visible: boolean) => void>();
  class CatalogObserver implements IntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly scrollMargin = "0px";
    readonly thresholds = [0];
    private readonly observed = new Map<Element, (visible: boolean) => void>();

    constructor(
      private readonly callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.root = options?.root ?? null;
      this.rootMargin = options?.rootMargin ?? "0px";
    }

    observe(target: Element) {
      const notify = (isIntersecting: boolean) => {
        const rect = target.getBoundingClientRect();
        this.callback(
          [
            {
              target,
              isIntersecting,
              intersectionRatio: isIntersecting ? 1 : 0,
              time: 0,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null,
            },
          ],
          this,
        );
      };
      this.observed.set(target, notify);
      targets.set(target, notify);
    }

    unobserve(target: Element) {
      // A previous ref's async cleanup must not remove a newer observer.
      if (targets.get(target) === this.observed.get(target)) {
        targets.delete(target);
      }
      this.observed.delete(target);
    }

    disconnect() {
      for (const target of this.observed.keys()) {
        this.unobserve(target);
      }
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", CatalogObserver);
  return (container: HTMLElement, visible = true) => {
    const sentinel = container.matches("[data-intro-video-avatar-thumbnail]")
      ? container
      : container.querySelector("[data-intro-video-catalog-sentinel]");
    const notify = sentinel ? targets.get(sentinel) : undefined;
    if (!notify) {
      throw new Error("Expected an observed catalog sentinel");
    }
    act(() => {
      notify(visible);
    });
  };
}

async function chooseStyle(user: ReturnType<typeof userEvent.setup>) {
  await user.click(requiredButtonNamed("Style reference: Let Okou choose"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  expect(within(picker).getByText("Let Okou choose")).toBeVisible();
  const preview = within(picker).getByLabelText("Preview Thriller");
  expect(preview).toBeVisible();
  expect(picker.querySelector("video")).toBeNull();
  await user.click(within(picker).getByLabelText("Select style Thriller"));
}

async function chooseAvatar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(requiredButtonNamed("Avatar: Auto · Okou decides"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose an avatar",
  });
  await user.click(
    within(picker).getByLabelText("Choose an avatar: Daphne in Grey blazer"),
  );
}

test("Intro Video remains behind the introVideo feature switch", async () => {
  installIntroVideoFixture();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: false },
  });

  expect(screen.queryByTestId("intro-video-start-card")).toBeNull();
});

test("Intro Video opens as one unrestricted multi-file form", async () => {
  installIntroVideoFixture();
  await setupIntroVideoPage();

  const dialog = await openIntroVideoDialog();
  expect(within(dialog).getByText("Create your intro video")).toBeVisible();
  const input = dialog.querySelector<HTMLInputElement>(
    '[data-intro-video-file-input=""]',
  );
  expect(input).not.toBeNull();
  expect(input).toHaveAttribute("multiple");
  expect(input).not.toHaveAttribute("accept");
  expect(requiredButtonNamed("Create video", dialog)).toBeDisabled();
});

test("Intro Video keeps the form and voice selection localized", async () => {
  const user = userEvent.setup({ delay: null });
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    featureSwitches: INTRO_VIDEO_SWITCHES,
    locale: "pt-BR",
  });
  click(await screen.findByTestId("intro-video-start-card"));
  const dialog = await screen.findByRole("dialog", {
    name: "Criar um vídeo de introdução",
  });
  expect(
    within(dialog).getByText("Crie seu vídeo de introdução"),
  ).toBeVisible();
  expect(
    requiredButtonNamed("Solte os arquivos aqui ou clique para enviar", dialog),
  ).toBeEnabled();
  await user.type(
    within(dialog).getByLabelText("O que o vídeo deve transmitir?"),
    "Apresente nosso produto em português.",
  );
  await user.click(requiredButtonNamed("Voz: Padrão · Segue o avatar", dialog));
  const picker = await screen.findByRole("dialog", { name: "Escolha uma voz" });
  expect(
    within(picker).getByText("Usar a voz padrão do avatar escolhido"),
  ).toBeVisible();
  await user.click(
    await within(picker).findByLabelText("Selecionar a voz Annie - Lifelike"),
  );
  expect(requiredButtonNamed("Voz: Annie - Lifelike", dialog)).toBeVisible();
  await user.click(requiredButtonNamed("Criar vídeo", dialog));
  await waitFor(() => {
    expect(submittedPrompt).toContain("Apresente nosso produto em português.");
    expect(submittedPrompt).toContain(
      "- Voice: Annie - Lifelike (330290724a1b470fb63153f34d4c0183)",
    );
  });
});

test("The whole upload area opens the file picker and still accepts drops", async () => {
  const user = userEvent.setup({ delay: null });
  installIntroVideoFixture();
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  const input = dialog.querySelector<HTMLInputElement>(
    "[data-intro-video-file-input]",
  );
  if (!input) {
    throw new Error("Expected the Intro Video file input");
  }
  const dropzone = requiredButtonNamed(
    "Drop files here or click to upload",
    dialog,
  );
  expect(dropzone).toHaveAttribute("data-intro-video-dropzone");
  expect(dropzone.querySelector("button, input")).toBeNull();
  const openFilePicker = vi.spyOn(input, "click").mockImplementation(() => {});
  await user.click(dropzone);
  expect(openFilePicker).toHaveBeenCalledTimes(1);
  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  expect(openFilePicker).toHaveBeenCalledTimes(3);

  fireEvent.drop(dropzone, {
    dataTransfer: { files: [new File(["notes"], "source.docx")] },
  });
  await expect(within(dialog).findByText("source.docx")).resolves.toBeVisible();
  expect(requiredButtonNamed("Create video", dialog)).toBeEnabled();
});

test("Styles automatically load near the end and keep existing choices", async () => {
  const user = userEvent.setup({ delay: null });
  const approachEnd = mockCatalogIntersection();
  installIntroVideoFixture();
  const nextPage = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    introVideoPresenterContract.styles,
    async ({ query, respond }) => {
      if (query.token === "next-styles") {
        await nextPage.promise;
        return respond(200, {
          styles: [
            {
              id: "portrait-style",
              name: "Portrait",
              thumbnailUrl: "https://files.heygen.test/portrait.jpg",
              aspectRatio: "9:16",
              tags: [],
            },
          ],
          hasMore: false,
          nextToken: null,
        });
      }
      return respond(200, {
        styles: [
          {
            id: "landscape-style",
            name: "Landscape",
            aspectRatio: "16:9",
            tags: [],
          },
        ],
        hasMore: true,
        nextToken: "next-styles",
      });
    },
  );
  await setupIntroVideoPage();
  await openIntroVideoDialog();
  await user.click(requiredButtonNamed("Style reference: Let Okou choose"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  await within(picker).findByText("Landscape");
  approachEnd(picker, false);
  expect(within(picker).getByText("Landscape")).toBeVisible();
  approachEnd(picker);
  await within(picker).findByText("Loading more options");
  expect(
    picker.querySelector("[data-intro-video-catalog-sentinel]"),
  ).toBeNull();
  nextPage.resolve();
  await user.click(within(picker).getByLabelText("Portrait · 9:16"));
  await within(picker).findByText("Portrait");
  await user.click(within(picker).getByLabelText("Landscape · 16:9"));
  expect(within(picker).getByText("Landscape")).toBeVisible();
  expect(
    picker.querySelector("[data-intro-video-catalog-sentinel]"),
  ).toBeNull();
});

test("A failed automatic page load keeps existing options and waits for a retry", async () => {
  const user = userEvent.setup({ delay: null });
  const approachEnd = mockCatalogIntersection();
  installIntroVideoFixture();
  let attempts = 0;
  context.mocks.api(
    introVideoPresenterContract.styles,
    ({ query, respond }) => {
      if (query.token === "next-styles") {
        attempts += 1;
        if (attempts === 1) {
          return respond(502, {
            error: {
              code: "HEYGEN_UNAVAILABLE",
              message: "Catalog unavailable",
            },
          });
        }
        return respond(200, {
          styles: [
            {
              id: "second-style",
              name: "Second style",
              aspectRatio: "16:9",
              tags: [],
            },
          ],
          hasMore: false,
          nextToken: null,
        });
      }
      return respond(200, {
        styles: [
          {
            id: "first-style",
            name: "First style",
            aspectRatio: "16:9",
            tags: [],
          },
        ],
        hasMore: true,
        nextToken: "next-styles",
      });
    },
  );
  await setupIntroVideoPage();
  await openIntroVideoDialog();
  await user.click(requiredButtonNamed("Style reference: Let Okou choose"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  await within(picker).findByText("First style");
  approachEnd(picker);
  const retry = await within(picker).findByText("Try again");
  expect(within(picker).getByText("First style")).toBeVisible();
  expect(
    picker.querySelector("[data-intro-video-catalog-sentinel]"),
  ).toBeNull();
  await user.click(retry);
  await within(picker).findByText("Second style");
  expect(within(picker).queryByText("Try again")).toBeNull();
  expect(
    picker.querySelector("[data-intro-video-catalog-sentinel]"),
  ).toBeNull();
});

test.each(["avatars", "styles"] as const)(
  "The %s catalog can recover when its first request fails",
  async (catalog) => {
    installIntroVideoFixture();
    let unavailable = true;
    const error = {
      error: { code: "HEYGEN_UNAVAILABLE", message: "Catalog unavailable" },
    };
    context.mocks.api(introVideoPresenterContract.avatars, ({ respond }) => {
      return unavailable
        ? respond(502, error)
        : respond(200, {
            avatars: [
              {
                id: "recovered-avatar",
                groupId: "recovered-group",
                name: "Recovered avatar",
                defaultVoiceId: "recovered-voice",
              },
            ],
            hasMore: false,
            nextToken: null,
          });
    });
    context.mocks.api(introVideoPresenterContract.styles, ({ respond }) => {
      return unavailable
        ? respond(502, error)
        : respond(200, {
            styles: [
              {
                id: "recovered-style",
                name: "Recovered style",
                aspectRatio: "16:9",
                tags: [],
              },
            ],
            hasMore: false,
            nextToken: null,
          });
    });
    await setupIntroVideoPage();
    const dialog = await openIntroVideoDialog();
    click(
      requiredButtonNamed(
        catalog === "avatars"
          ? "Avatar: Auto · Okou decides"
          : "Style reference: Let Okou choose",
        dialog,
      ),
    );
    const picker = await screen.findByRole("dialog", {
      name:
        catalog === "avatars" ? "Choose an avatar" : "Choose a style reference",
    });
    const retry = await within(picker).findByText("Try again");
    unavailable = false;
    click(retry);
    const choice = await within(picker).findByLabelText(
      catalog === "avatars"
        ? "Choose an avatar: Recovered avatar"
        : "Select style Recovered style",
    );
    click(choice);
    expect(
      requiredButtonNamed(
        catalog === "avatars"
          ? "Avatar: Recovered avatar"
          : "Style reference: Recovered style",
        dialog,
      ),
    ).toBeVisible();
  },
);

test("A style previews inline without a third dialog or selecting it", async () => {
  const user = userEvent.setup({ delay: null });
  installIntroVideoFixture();
  await setupIntroVideoPage();
  await openIntroVideoDialog();
  await user.click(requiredButtonNamed("Style reference: Let Okou choose"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  const preview = await within(picker).findByLabelText("Preview Thriller");
  await user.click(preview);
  expect(screen.queryByRole("dialog", { name: "Thriller" })).toBeNull();
  const video = picker.querySelector("video");
  if (!video) {
    throw new Error("Expected the HeyGen style preview video");
  }
  expect(video).toHaveAttribute(
    "src",
    "https://files.heygen.test/thriller.mp4",
  );
  expect(video).toHaveAttribute("controls");
  expect(video).toHaveAttribute("playsinline");
  expect(video.closest("button")).toBeNull();

  expect(video.closest('[role="dialog"]')).toBe(picker);
  expect(
    within(picker).getByLabelText("Select style Thriller"),
  ).toHaveAttribute("aria-pressed", "false");
  await user.click(requiredButtonNamed("Close", picker));
  expect(video).not.toBeInTheDocument();
  await user.click(requiredButtonNamed("Style reference: Let Okou choose"));
  const reopened = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  expect(reopened.querySelector("video")).toBeNull();
  await user.click(within(reopened).getByLabelText("Select style Thriller"));
  await waitFor(() => {
    expect(requiredButtonNamed("Style reference: Thriller")).toBeVisible();
  });
});

test("Only one inline style preview is mounted and changing format stops it", async () => {
  installIntroVideoFixture();
  context.mocks.api(introVideoPresenterContract.styles, ({ respond }) => {
    return respond(200, {
      styles: [
        {
          id: "one",
          name: "First video",
          aspectRatio: "16:9",
          tags: [],
          previewVideoUrl: "https://files.heygen.test/first.mp4",
        },
        {
          id: "two",
          name: "Second video",
          aspectRatio: "16:9",
          tags: [],
          previewVideoUrl: "https://files.heygen.test/second.mp4",
        },
      ],
      hasMore: false,
      nextToken: null,
    });
  });
  await setupIntroVideoPage();
  await openIntroVideoDialog();
  click(requiredButtonNamed("Style reference: Let Okou choose"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  click(await within(picker).findByLabelText("Preview First video"));
  const first = within(picker).getByLabelText("First video");
  click(within(picker).getByLabelText("Preview Second video"));
  expect(first).not.toBeInTheDocument();
  expect(picker.querySelectorAll("video")).toHaveLength(1);
  expect(within(picker).getByLabelText("Second video")).toHaveAttribute(
    "src",
    "https://files.heygen.test/second.mp4",
  );
  click(within(picker).getByLabelText("Portrait · 9:16"));
  expect(picker.querySelector("video")).toBeNull();
  click(within(picker).getByLabelText("Landscape · 16:9"));
  expect(picker.querySelector("video")).toBeNull();
});

test("A failed preview keeps style selection available", async () => {
  const user = userEvent.setup({ delay: null });
  installIntroVideoFixture();
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  await user.click(
    requiredButtonNamed("Style reference: Let Okou choose", dialog),
  );
  const picker = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  await user.click(await within(picker).findByLabelText("Preview Thriller"));
  const video = picker.querySelector("video");
  if (!video) {
    throw new Error("Expected the style preview video");
  }
  fireEvent.error(video);
  await user.click(requiredButtonNamed("Select style Thriller", picker));
  expect(
    requiredButtonNamed("Style reference: Thriller", dialog),
  ).toBeVisible();
});

test("A prompt alone creates an Intro Video chat", async () => {
  const user = userEvent.setup({ delay: null });
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();

  await user.type(
    within(dialog).getByLabelText("What should the video do?"),
    "Create a concise launch video for non-technical business users.",
  );
  await user.click(requiredButtonNamed("Create video", dialog));

  await waitFor(() => {
    expect(submittedPrompt).toContain(
      "Use the $intro-video skill to create one polished intro video.",
    );
  });
  expect(submittedPrompt).toContain(
    "- Sources: none; research or create supporting material as needed",
  );
  expect(submittedPrompt).toContain(
    "Create a concise launch video for non-technical business users.",
  );
  expect(submittedPrompt).toContain(
    "- HeyGen style: Auto — choose the best visual direction",
  );
  expect(submittedPrompt).toContain(
    "- Voice: Default — follow the chosen avatar",
  );
  expect(submittedPrompt).toContain(
    "- Aspect ratio: Auto — infer from the user request, source material, and destination",
  );
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

test("Style format filtering does not change the explicit output ratio", async () => {
  const user = userEvent.setup({ delay: null });
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  context.mocks.api(introVideoPresenterContract.styles, ({ respond }) => {
    return respond(200, {
      styles: [
        { id: "wide", name: "Wide story", aspectRatio: "16:9", tags: [] },
        { id: "tall", name: "Tall story", aspectRatio: "9:16", tags: [] },
      ],
      hasMore: false,
      nextToken: null,
    });
  });
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  await user.type(
    within(dialog).getByLabelText("What should the video do?"),
    "Create a vertical product launch.",
  );
  const output = within(dialog).getByLabelText("Output format");
  await user.click(within(output).getByText("9:16"));
  await user.click(
    requiredButtonNamed("Style reference: Let Okou choose", dialog),
  );
  const picker = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  await within(picker).findByText("Wide story");
  const formats = within(picker).getByLabelText(
    "Filter style references by format",
  );
  expect(
    queryAllByRoleFast("radio", formats).map((format) => {
      return format.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Landscape · 16:9", "Portrait · 9:16"]);
  expect(within(picker).queryByText("Tall story")).toBeNull();
  expect(within(picker).getByText("Wide story")).toBeVisible();
  await user.click(within(formats).getByLabelText("Portrait · 9:16"));
  expect(within(picker).getByText("Tall story")).toBeVisible();
  await user.click(within(formats).getByLabelText("Landscape · 16:9"));
  await user.click(within(picker).getByLabelText("Select style Wide story"));
  await user.click(requiredButtonNamed("Create video", dialog));
  await waitFor(() => {
    expect(submittedPrompt).toContain("- Aspect ratio: 9:16");
  });
  expect(submittedPrompt).toContain(
    "- HeyGen style reference aspect ratio: 16:9",
  );
  expect(submittedPrompt).toContain("not a native HeyGen template");
});

test("An expired catalog cursor reloads the catalog instead of retrying that cursor", async () => {
  const user = userEvent.setup({ delay: null });
  const intersect = mockCatalogIntersection();
  installIntroVideoFixture();
  let expired = false;
  context.mocks.api(
    introVideoPresenterContract.styles,
    ({ query, respond }) => {
      if (query.token) {
        expired = true;
        return respond(400, {
          error: { code: "BAD_REQUEST", message: "Invalid pagination token" },
        });
      }
      return respond(200, {
        styles: [
          {
            id: expired ? "fresh" : "old",
            name: expired ? "Fresh style" : "Old style",
            aspectRatio: "16:9",
            tags: [],
          },
        ],
        hasMore: !expired,
        nextToken: expired ? null : "expired",
      });
    },
  );
  await setupIntroVideoPage();
  await openIntroVideoDialog();
  await user.click(requiredButtonNamed("Style reference: Let Okou choose"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a style reference",
  });
  await within(picker).findByText("Old style");
  intersect(picker);
  await user.click(await within(picker).findByText("Reload catalog"));
  await within(picker).findByText("Fresh style");
  expect(within(picker).queryByText("Old style")).toBeNull();
  expect(within(picker).queryByText("Reload catalog")).toBeNull();
});

test("Cancelling a partially uploaded video draft leaves the chat draft intact and does not leak files on reopen", async () => {
  const user = userEvent.setup({ delay: null });
  let submittedPrompt: string | undefined;
  let submittedMessage: unknown;
  let clearedChatDraft = false;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
      submittedMessage = body.userMessage;
    },
  });
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    if (body.draftUserMessage === null) {
      clearedChatDraft = true;
    }
    return respond(204);
  });
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    if (body.filename === "broken.txt") {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Upload failed" },
      });
    }
    return respond(200, {
      id: "f0000000-0000-4000-a000-000000000054",
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: "https://files.example.test/retained.txt",
      uploadUrl: "https://mock-upload.r2.test/retained",
      uploadHeaders: {},
    });
  });
  context.mocks.http.put("https://mock-upload.r2.test/retained", () => {
    return new HttpResponse(null, { status: 200 });
  });
  await setupIntroVideoPage();
  await fillComposer(await findComposer(), "My unrelated chat draft");
  const dialog = await openIntroVideoDialog();
  const input = dialog.querySelector<HTMLInputElement>("input[type=file]");
  if (!input) {
    throw new Error("Expected source input");
  }
  await user.upload(input, [
    new File(["first"], "retained.txt"),
    new File(["second"], "broken.txt"),
  ]);
  await user.click(requiredButtonNamed("Create video", dialog));
  await within(dialog).findByText(
    "One or more files could not be uploaded. Remove them or try again.",
  );
  await user.click(requiredButtonNamed("Cancel", dialog));
  await expect(findComposer()).resolves.toHaveTextContent(
    "My unrelated chat draft",
  );
  const reopened = await openIntroVideoDialog();
  expect(within(reopened).queryByText("retained.txt")).toBeNull();
  await user.type(
    within(reopened).getByLabelText("What should the video do?"),
    "Make a new video without files.",
  );
  await user.click(requiredButtonNamed("Create video", reopened));
  await waitFor(() => {
    expect(submittedPrompt).toContain("Make a new video without files.");
  });
  expect(submittedPrompt).not.toContain("My unrelated chat draft");
  expect(clearedChatDraft).toBeFalsy();
  expect(JSON.stringify(submittedMessage)).not.toContain(
    "f0000000-0000-4000-a000-000000000054",
  );
});

test("Voices automatically page, retry failures, and do not label the first voice as recommended", async () => {
  const user = userEvent.setup({ delay: null });
  const intersect = mockCatalogIntersection();
  installIntroVideoFixture();
  let failedOnce = false;
  context.mocks.api(
    introVideoPresenterContract.voices,
    ({ query, respond }) => {
      if (query.token && !failedOnce) {
        failedOnce = true;
        return respond(502, {
          error: { code: "HEYGEN_UNAVAILABLE", message: "Unavailable" },
        });
      }
      return respond(200, {
        voices: [
          {
            id: query.token ? "second" : "first",
            name: query.token ? "Second voice" : "First voice",
            language: "English",
          },
        ],
        hasMore: !query.token,
        nextToken: query.token ? null : "next-voices",
      });
    },
  );
  await setupIntroVideoPage();
  await openIntroVideoDialog();
  await user.click(requiredButtonNamed("Voice: Default · Follows avatar"));
  const picker = await screen.findByRole("dialog", { name: "Choose a voice" });
  await within(picker).findByLabelText("Select voice First voice");
  expect(within(picker).queryByText("Recommended")).toBeNull();
  intersect(picker);
  await user.click(await within(picker).findByText("Try again"));
  await within(picker).findByLabelText("Select voice Second voice");
  expect(
    within(picker).getByLabelText("Select voice First voice"),
  ).toBeVisible();
  expect(
    picker.querySelector("[data-intro-video-catalog-sentinel]"),
  ).toBeNull();
});

test.each(["source.mp4", "source.wav"])(
  "Original audio is available for %s even without a browser MIME type",
  async (filename) => {
    const user = userEvent.setup({ delay: null });
    installIntroVideoFixture();
    await setupIntroVideoPage();
    const dialog = await openIntroVideoDialog();
    const input = dialog.querySelector<HTMLInputElement>("input[type=file]");
    if (!input) {
      throw new Error("Expected source input");
    }
    await user.upload(input, new File(["media"], filename));
    await user.click(
      requiredButtonNamed("Voice: Default · Follows avatar", dialog),
    );
    const picker = await screen.findByRole("dialog", {
      name: "Choose a voice",
    });
    await user.click(within(picker).getByText("Original audio"));
    expect(requiredButtonNamed("Voice: Original audio", dialog)).toBeVisible();
    await user.click(within(dialog).getByLabelText(`Remove ${filename}`));
    expect(
      requiredButtonNamed("Voice: Default · Follows avatar", dialog),
    ).toBeVisible();
  },
);

test("The form accepts multiple unrelated source types", async () => {
  const user = userEvent.setup({ delay: null });
  installIntroVideoFixture();
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  const input = dialog.querySelector<HTMLInputElement>(
    '[data-intro-video-file-input=""]',
  );
  if (!input) {
    throw new Error("Intro Video file input not found");
  }

  await user.upload(input, [
    new File(["deck"], "launch.pptx"),
    new File(["notes"], "notes.docx"),
    new File(["video"], "walkthrough.mp4", { type: "video/mp4" }),
  ]);

  expect(within(dialog).getByText("launch.pptx")).toBeVisible();
  expect(within(dialog).getByText("notes.docx")).toBeVisible();
  expect(within(dialog).getByText("walkthrough.mp4")).toBeVisible();
  expect(requiredButtonNamed("Create video", dialog)).toBeEnabled();
});

test("An in-flight Intro Video submission keeps its files and settings intact", async () => {
  const user = userEvent.setup({ delay: null });
  const uploadGate = context.mocks.deferred<void>();
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  const uploadUrl = "https://mock-upload.r2.test/intro-video-pending";
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    return respond(200, {
      id: "f0000000-0000-4000-a000-000000000052",
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: "https://files.example.test/brief.txt",
      uploadUrl,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(uploadUrl, async ({ withSignal }) => {
    await withSignal(uploadGate.promise);
    return new HttpResponse(null, { status: 200 });
  });
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  const prompt = within(dialog).getByLabelText("What should the video do?");
  await user.type(prompt, "Preserve this launch brief.");
  const input = dialog.querySelector<HTMLInputElement>("input[type=file]");
  if (!input) {
    throw new Error("Expected source input");
  }
  await user.upload(
    input,
    new File(["brief"], "brief.txt", { type: "text/plain" }),
  );
  click(requiredButtonNamed("Create video", dialog));
  await waitFor(() => {
    expect(prompt).toBeDisabled();
  });
  expect(requiredButtonNamed("Cancel", dialog)).toBeDisabled();
  expect(
    requiredButtonNamed("Avatar: Auto · Okou decides", dialog),
  ).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(dialog).toBeVisible();
  expect(prompt).toHaveValue("Preserve this launch brief.");
  expect(within(dialog).getByText("brief.txt")).toBeVisible();
  uploadGate.resolve();
  await waitFor(() => {
    expect(submittedPrompt).toContain("Preserve this launch brief.");
  });
  expect(submittedPrompt).toContain("- Source: brief.txt (file)");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

test("A failed upload keeps the request editable and can be retried", async () => {
  const user = userEvent.setup({ delay: null });
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  context.mocks.api(uploadsContract.prepare, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Upload unavailable" },
    });
  });
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  const prompt = within(dialog).getByLabelText("What should the video do?");
  const input = dialog.querySelector<HTMLInputElement>("input[type=file]");
  if (!input) {
    throw new Error("Expected source input");
  }
  await user.upload(input, new File(["brief"], "launch.pdf"));
  await user.type(prompt, "Keep this brief.");
  await user.click(requiredButtonNamed("Create video", dialog));
  const error = await within(dialog).findByText(
    "One or more files could not be uploaded. Remove them or try again.",
  );
  expect(error).toBeVisible();
  expect(prompt).toBeEnabled();
  expect(within(dialog).getByText("launch.pdf")).toBeVisible();
  context.mocks.upload.success({
    id: "f0000000-0000-4000-a000-000000000053",
    filename: "launch.pdf",
    contentType: "application/pdf",
    size: 5,
    url: "https://files.example.test/launch.pdf",
  });
  await user.type(prompt, " Use a warm tone.");
  await user.click(requiredButtonNamed("Create video", dialog));
  await waitFor(() => {
    expect(submittedPrompt).toContain("Keep this brief. Use a warm tone.");
  });
  expect(submittedPrompt).toContain("- Source: launch.pdf (presentation)");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

test("Retrying a partial upload reuses completed files and submits each source once", async () => {
  const user = userEvent.setup({ delay: null });
  let secondUploadFailed = false;
  const originalUploadIds = new Map<string, string>();
  let submittedMessage: unknown;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedMessage = body.userMessage;
    },
  });
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    if (body.filename === "second.txt" && !secondUploadFailed) {
      secondUploadFailed = true;
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Upload failed" },
      });
    }
    // A new preparation creates a new public attachment identity. The final
    // message must reuse the first successful identity for each source.
    const id = crypto.randomUUID();
    if (!originalUploadIds.has(body.filename)) {
      originalUploadIds.set(body.filename, id);
    }
    return respond(200, {
      id,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: `https://files.example.test/${body.filename}`,
      uploadUrl: "https://mock-upload.r2.test/partial",
      uploadHeaders: {},
    });
  });
  context.mocks.http.put("https://mock-upload.r2.test/partial", () => {
    return new HttpResponse(null, { status: 200 });
  });
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  const input = dialog.querySelector<HTMLInputElement>("input[type=file]");
  if (!input) {
    throw new Error("Expected source input");
  }
  await user.upload(input, [
    new File(["first"], "first.txt"),
    new File(["second"], "second.txt"),
  ]);
  await user.click(requiredButtonNamed("Create video", dialog));
  await within(dialog).findByText(
    "One or more files could not be uploaded. Remove them or try again.",
  );
  await user.click(requiredButtonNamed("Create video", dialog));
  await waitFor(() => {
    expect(submittedMessage).toBeDefined();
  });
  const message = JSON.stringify(submittedMessage);
  for (const filename of ["first.txt", "second.txt"]) {
    const id = originalUploadIds.get(filename);
    if (!id) {
      throw new Error(`Expected a successful upload of ${filename}`);
    }
    expect(message.match(new RegExp(id, "gu"))).toHaveLength(1);
  }
});

test.each(["load", "error"] as const)(
  "Avatar thumbnails wait for their main preview to settle (%s)",
  async (event) => {
    const intersect = mockCatalogIntersection();
    installIntroVideoFixture();
    await setupIntroVideoPage();
    const dialog = await openIntroVideoDialog();
    click(requiredButtonNamed("Avatar: Auto · Okou decides", dialog));
    const picker = await screen.findByRole("dialog", {
      name: "Choose an avatar",
    });
    const preview = await within(picker).findByAltText("Daphne in Grey blazer");
    const thumbnail = within(picker)
      .getByLabelText("Preview look Daphne in Grey blazer")
      .querySelector("img");
    expect(preview).toHaveAttribute(
      "src",
      "https://files.heygen.test/daphne.webp",
    );
    expect(thumbnail).not.toHaveAttribute("src");
    if (!thumbnail) {
      throw new Error("Expected the look thumbnail");
    }
    intersect(thumbnail, false);
    fireEvent[event](preview);
    expect(thumbnail).not.toHaveAttribute("src");
    intersect(thumbnail);
    expect(thumbnail).toHaveAttribute(
      "src",
      "https://files.heygen.test/daphne.webp",
    );
    click(
      requiredButtonNamed("Choose an avatar: Daphne in Grey blazer", picker),
    );
    expect(
      requiredButtonNamed("Avatar: Daphne in Grey blazer", dialog),
    ).toBeVisible();
  },
);

test("A selected public avatar uses its HeyGen default voice", async () => {
  const user = userEvent.setup({ delay: null });
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  await user.type(
    within(dialog).getByLabelText("What should the video do?"),
    "Explain the product in 45 seconds.",
  );
  await chooseStyle(user);
  await chooseAvatar(user);

  expect(
    requiredButtonNamed("Voice: Default · Daphne in Grey blazer", dialog),
  ).toBeVisible();
  await user.click(requiredButtonNamed("Create video", dialog));

  await waitFor(() => {
    expect(submittedPrompt).toContain(
      "- HeyGen style: Thriller (349d91e1ad2444eabab2672a9057f298)",
    );
  });
  expect(submittedPrompt).toContain(
    "- HeyGen avatar group ID: c1926d821b4d43d6a5f07f2985bb5cd1",
  );
  expect(submittedPrompt).toContain(
    "- HeyGen avatar default voice ID: 812d4eea4a8442a382dcaf2dbaddbd93",
  );
  expect(submittedPrompt).toContain(
    "- Voice: Default — follow Daphne in Grey blazer (812d4eea4a8442a382dcaf2dbaddbd93)",
  );
});

test("Avatar looks share a person card across pages and only Use commits a look", async () => {
  const user = userEvent.setup({ delay: null });
  const approachEnd = mockCatalogIntersection();
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  const firstLook: IntroVideoAvatar = {
    id: "Daphne_public_1",
    groupId: "daphne-group",
    name: "Daphne in Grey blazer",
    defaultVoiceId: "daphne-default-voice",
    previewImageUrl: "https://files.heygen.test/daphne-grey.webp",
  };
  const secondLook: IntroVideoAvatar = {
    ...firstLook,
    id: "Daphne_public_2",
    name: "Daphne in White shirt",
    defaultVoiceId: "daphne-white-default-voice",
    previewImageUrl: "https://files.heygen.test/daphne-white.webp",
  };
  context.mocks.api(
    introVideoPresenterContract.avatars,
    ({ query, respond }) => {
      expect(query.pageSize).toBe(24);
      if (query.token === "next-looks") {
        return respond(200, {
          avatars: [firstLook, secondLook],
          hasMore: false,
          nextToken: null,
        });
      }
      expect(query.token).toBeUndefined();
      return respond(200, {
        avatars: [
          firstLook,
          { ...firstLook, id: "Other_Daphne_1", groupId: "other-daphne-group" },
        ],
        hasMore: true,
        nextToken: "next-looks",
      });
    },
  );
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  await user.type(
    within(dialog).getByLabelText("What should the video do?"),
    "Explain the product.",
  );
  await user.click(requiredButtonNamed("Avatar: Auto · Okou decides", dialog));
  const picker = await screen.findByRole("dialog", {
    name: "Choose an avatar",
  });
  await waitFor(() => {
    expect(
      picker.querySelectorAll("[data-intro-video-avatar-group]"),
    ).toHaveLength(2);
  });
  fireEvent.load(within(picker).getAllByAltText(firstLook.name)[0]!);
  approachEnd(picker);
  await within(picker).findByLabelText("Preview look Daphne in White shirt");
  // Same-name people stay separate; a repeated look and a new page do not add cards.
  expect(
    picker.querySelectorAll("[data-intro-video-avatar-group]"),
  ).toHaveLength(2);
  const group = picker.querySelector<HTMLElement>(
    '[data-intro-video-avatar-group="daphne-group"]',
  );
  if (!group) {
    throw new Error("Expected the grouped Daphne card");
  }
  expect(group.querySelectorAll('[aria-label^="Preview look"]')).toHaveLength(
    2,
  );
  const nextThumbnail = within(group)
    .getByLabelText("Preview look Daphne in White shirt")
    .querySelector("img");
  if (!nextThumbnail) {
    throw new Error("Expected the new look thumbnail");
  }
  expect(nextThumbnail).not.toHaveAttribute("src");
  approachEnd(nextThumbnail);
  expect(nextThumbnail).toHaveAttribute("src", secondLook.previewImageUrl);
  await user.click(
    within(group).getByLabelText("Preview look Daphne in White shirt"),
  );
  expect(within(group).getByAltText(secondLook.name)).toHaveAttribute(
    "src",
    secondLook.previewImageUrl,
  );
  expect(picker).toBeVisible();
  await user.click(requiredButtonNamed("Close", picker));
  expect(
    requiredButtonNamed("Avatar: Auto · Okou decides", dialog),
  ).toBeVisible();
  await user.click(requiredButtonNamed("Avatar: Auto · Okou decides", dialog));
  const reopenedPicker = await screen.findByRole("dialog", {
    name: "Choose an avatar",
  });
  await user.click(
    await within(reopenedPicker).findByLabelText(
      "Choose an avatar: Daphne in White shirt",
    ),
  );
  expect(
    requiredButtonNamed("Avatar: Daphne in White shirt", dialog),
  ).toBeVisible();
  await user.click(requiredButtonNamed("Create video", dialog));
  await waitFor(() => {
    expect(submittedPrompt).toContain("Daphne_public_2");
  });
  expect(submittedPrompt).toContain("- HeyGen avatar group ID: daphne-group");
  expect(submittedPrompt).toContain(
    "- HeyGen avatar default voice ID: daphne-white-default-voice",
  );
});

test("No avatar gives the voice an independent Okou choice", async () => {
  const user = userEvent.setup({ delay: null });
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  await user.type(
    within(dialog).getByLabelText("What should the video do?"),
    "Create a caption-led product introduction.",
  );

  await user.click(requiredButtonNamed("Avatar: Auto · Okou decides", dialog));
  const avatarPicker = await screen.findByRole("dialog", {
    name: "Choose an avatar",
  });
  await user.click(within(avatarPicker).getByText("No avatar"));

  const voiceTrigger = requiredButtonNamed("Voice: Let Okou choose", dialog);
  expect(voiceTrigger).toBeVisible();
  await user.click(voiceTrigger);
  const voicePicker = await screen.findByRole("dialog", {
    name: "Choose a voice",
  });
  expect(within(voicePicker).getByText("Let Okou choose")).toBeVisible();
  expect(
    within(voicePicker).queryByText("Default · Follows avatar"),
  ).toBeNull();
  await user.click(within(voicePicker).getByText("Let Okou choose"));
  await user.click(requiredButtonNamed("Create video", dialog));

  await waitFor(() => {
    expect(submittedPrompt).toContain("- Avatar: No avatar");
  });
  expect(submittedPrompt).toContain(
    "- Voice: Auto — choose a suitable public HeyGen voice",
  );
});

test("A public HeyGen voice overrides the avatar default", async () => {
  const user = userEvent.setup({ delay: null });
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  await setupIntroVideoPage();
  const dialog = await openIntroVideoDialog();
  await user.type(
    within(dialog).getByLabelText("What should the video do?"),
    "Create a short product introduction.",
  );
  await chooseAvatar(user);
  await user.click(
    requiredButtonNamed("Voice: Default · Daphne in Grey blazer", dialog),
  );
  const picker = await screen.findByRole("dialog", { name: "Choose a voice" });
  await user.click(
    await within(picker).findByLabelText("Select voice Annie - Lifelike"),
  );
  await user.click(requiredButtonNamed("Create video", dialog));

  await waitFor(() => {
    expect(submittedPrompt).toContain(
      "- Voice: Annie - Lifelike (330290724a1b470fb63153f34d4c0183)",
    );
  });
  expect(submittedPrompt).toContain(
    "- HeyGen avatar default voice ID: 812d4eea4a8442a382dcaf2dbaddbd93",
  );
});

test("A desktop recording handoff submits the original recording and clicks once with the selected audio intent", async () => {
  let submitted:
    | Parameters<NonNullable<MessageExperienceOptions["onSendRequest"]>>[0]
    | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submitted = body;
    },
  });
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    return respond(200, {
      url: `https://resolved.example/${query.file_id}`,
      publicUrl: `https://cdn.vm7.io/artifacts/tests/intro-video/${query.file_id}`,
    });
  });
  await setupIntroVideoPage(
    `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat?${new URLSearchParams(DESKTOP_HANDOFF_PARAMS).toString()}`,
  );

  const dialog = await screen.findByRole("dialog", {
    name: "Create an intro video",
  });
  expect(within(dialog).getByText("demo.mp4")).toBeVisible();
  click(requiredButtonNamed("Voice: Default · Follows avatar", dialog));
  const voicePicker = await screen.findByRole("dialog", {
    name: "Choose a voice",
  });
  click(within(voicePicker).getByText("Original audio"));
  expect(requiredButtonNamed("Voice: Original audio", dialog)).toBeVisible();
  click(requiredButtonNamed("Create video", dialog));
  await waitFor(() => {
    expect(submitted).toBeDefined();
  });
  const files = submitted?.userMessage?.parts.filter((part) => {
    return part.type === "file";
  });
  expect(files).toHaveLength(2);
  expect(
    files?.map((file) => {
      return file.fileId;
    }),
  ).toStrictEqual(
    expect.arrayContaining([
      DESKTOP_HANDOFF_PARAMS["intro-video-recording"],
      DESKTOP_HANDOFF_PARAMS["intro-video-clicks"],
    ]),
  );
  expect(submitted?.prompt).toContain("- Source: demo.mp4 (video)");
  expect(submitted?.prompt).toContain("- Voice: Use original source audio");
});

test.each([true, false])(
  "A desktop recording reaches review after onboarding (needed: %s)",
  async (needsOnboarding) => {
    installIntroVideoFixture();
    context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
      return respond(200, {
        url: `https://resolved.example/${query.file_id}`,
        publicUrl: `https://cdn.vm7.io/artifacts/tests/intro-video/${query.file_id}`,
      });
    });
    context.mocks.data.onboardingStatus({
      needsOnboarding,
      onboardingComplete: !needsOnboarding,
      defaultAgentId: MESSAGE_EXPERIENCE_AGENT_ID,
    });
    const params = new URLSearchParams({
      ...DESKTOP_HANDOFF_PARAMS,
      choice: "explore",
      category: "engineering",
      onboarding_note: "stale onboarding note",
      "x-vercel-protection-bypass": "preview-only-secret",
    });
    await setupPage({
      context,
      host: "app.okou.ai",
      path: `/onboarding?${params.toString()}`,
      featureSwitches: INTRO_VIDEO_SWITCHES,
    });
    if (needsOnboarding) {
      click(
        await screen.findByRole("radio", {
          name: /I will explore on my own/u,
        }),
      );
    }
    const dialog = await screen.findByRole("dialog", {
      name: "Create an intro video",
    });
    await expect(within(dialog).findByText("demo.mp4")).resolves.toBeVisible();
    const preview = within(dialog).getByLabelText("Video preview for demo.mp4");
    expect(preview).toHaveAttribute(
      "src",
      "https://resolved.example/video-upload-id",
    );
    expect(preview).toHaveAttribute("controls");
    expect(preview).toHaveAttribute("playsinline");
    expect(preview).not.toHaveAttribute("autoplay");
    await waitFor(() => {
      expect(search()).toBe("");
    });
    click(requiredButtonNamed("Remove demo.mp4", dialog));
    await waitFor(() => {
      expect(preview).not.toBeInTheDocument();
      expect(within(dialog).queryByText("demo.mp4")).not.toBeInTheDocument();
    });
  },
);
