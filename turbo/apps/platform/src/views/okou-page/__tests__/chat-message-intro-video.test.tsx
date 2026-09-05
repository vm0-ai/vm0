import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { introVideoPresenterContract } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

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

async function chooseStyle(user: ReturnType<typeof userEvent.setup>) {
  await user.click(requiredButtonNamed("Video style: Let Okou choose"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a video style",
  });
  expect(within(picker).queryByText("No video style")).toBeNull();
  expect(within(picker).getByText("Let Okou choose")).toBeVisible();
  const preview = within(picker).getByLabelText(
    "Play video template preview Thriller",
  );
  expect(preview).toBeVisible();
  const video = picker.querySelector<HTMLVideoElement>(
    'video[src="https://files.heygen.test/thriller.mp4"]',
  );
  expect(video).not.toBeNull();
  expect(video).toHaveAttribute(
    "poster",
    "https://files.heygen.test/thriller.jpg",
  );
  expect(video).toHaveAttribute("preload", "none");
  expect(video).toHaveAttribute("playsinline");
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
  expect(within(dialog).queryByText("How do you want to start?")).toBeNull();
  expect(within(dialog).queryByText("Record your screen")).toBeNull();
  expect(within(dialog).queryByText("Review your intro video")).toBeNull();
  const input = dialog.querySelector<HTMLInputElement>(
    '[data-intro-video-file-input=""]',
  );
  expect(input).not.toBeNull();
  expect(input).toHaveAttribute("multiple");
  expect(input).not.toHaveAttribute("accept");
  expect(requiredButtonNamed("Create video", dialog)).toBeDisabled();
});

test("Style previews can play and pause without selecting a style", async () => {
  const user = userEvent.setup({ delay: null });
  installIntroVideoFixture();
  await setupIntroVideoPage();
  await openIntroVideoDialog();
  await user.click(requiredButtonNamed("Video style: Let Okou choose"));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a video style",
  });
  const preview = await within(picker).findByLabelText(
    "Play video template preview Thriller",
  );
  const video = picker.querySelector("video");
  if (!video) {
    throw new Error("Expected the HeyGen style preview video");
  }
  const play = vi.spyOn(video, "play").mockResolvedValue();
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {
    fireEvent.pause(video);
  });
  await user.click(preview);
  expect(play).toHaveBeenCalledOnce();
  fireEvent.playing(video);
  const card = video.closest("[data-intro-video-style-preview]");
  expect(card).toHaveAttribute("data-preview-playing", "true");

  await user.click(
    within(picker).getByLabelText("Pause video style preview Thriller"),
  );
  expect(pause).toHaveBeenCalledOnce();
  expect(card).toHaveAttribute("data-preview-playing", "false");
  expect(picker).toBeVisible();
  expect(
    within(picker).getByLabelText("Select style Thriller"),
  ).toHaveAttribute("aria-pressed", "false");
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
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

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

test("An existing desktop recording handoff still opens in the simple form", async () => {
  installIntroVideoFixture();
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
  expect(within(dialog).queryByText("Record your screen")).toBeNull();
});
