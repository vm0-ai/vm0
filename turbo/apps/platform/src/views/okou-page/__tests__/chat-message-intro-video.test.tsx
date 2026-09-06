import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { introVideoPresenterContract } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { search } from "../../../signals/location.ts";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findFastControl,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const DESKTOP_HANDOFF_PARAMS = {
  "intro-video-recording": "video-upload-id",
  "intro-video-recording-name": "demo.mp4",
  "intro-video-recording-size": "1024",
  "intro-video-clicks": "events-upload-id",
  "intro-video-clicks-name": "demo.clicks.json",
  "intro-video-clicks-size": "512",
  "intro-video-user": "test-user-123",
} as const;

const INTRO_VIDEO_SWITCHES = {
  [FeatureSwitchKey.IntroVideo]: true,
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

async function openIntroVideoDialog(): Promise<HTMLElement> {
  click(await screen.findByTestId("intro-video-start-card"));
  return await screen.findByRole("dialog", {
    name: "Create an intro video",
  });
}

async function uploadLaunchPresentation(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
): Promise<void> {
  const input = dialog.querySelector<HTMLInputElement>(
    '[data-intro-video-presentation-input=""]',
  );
  if (!input) {
    throw new Error("Intro-video presentation input not found");
  }
  await user.upload(
    input,
    new File(["launch source"], "launch.pdf", {
      type: "application/pdf",
    }),
  );
  await expect(
    within(dialog).findByText("Choose an avatar"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByText("Your source is ready")).toBeNull();
}

async function clickDialogButton(
  dialog: HTMLElement,
  name: string,
): Promise<void> {
  click(await findFastControl("button", name, dialog));
}

async function reviewWithoutAvatar(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
): Promise<void> {
  await uploadLaunchPresentation(user, dialog);
  await reviewSourceWithoutAvatar(dialog, "No voiceover");
}

async function reviewSourceWithoutAvatar(
  dialog: HTMLElement,
  voice: "No voiceover" | "Original audio",
): Promise<void> {
  await clickDialogButton(dialog, "Next");
  await expect(
    within(dialog).findByText("Choose a voice"),
  ).resolves.toBeVisible();
  click(buttonContaining(dialog, voice));
  await clickDialogButton(dialog, "Next");
  await expect(
    within(dialog).findByText("Review your intro video"),
  ).resolves.toBeVisible();
}

function resolveDesktopRecordingFiles(): void {
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    return respond(200, {
      url: `https://resolved.example/${query.file_id}`,
      publicUrl: `https://cdn.vm7.io/artifacts/tests/intro-video/${query.file_id}`,
    });
  });
}

function buttonContaining(container: ParentNode, text: string): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.includes(text);
  });
  if (!button) {
    throw new Error(`Button containing ${text} not found`);
  }
  return button;
}

test("An uploaded deck opens at the presenter without requiring source review", async () => {
  const user = userEvent.setup({ delay: null });
  installIntroVideoFixture();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: true },
  });

  const dialog = await openIntroVideoDialog();
  await uploadLaunchPresentation(user, dialog);
  expect(
    within(dialog).queryByText("Where should the presenter stand?"),
  ).toBeNull();
  await clickDialogButton(dialog, "Next");
  await expect(
    within(dialog).findByText("Choose a voice"),
  ).resolves.toBeVisible();
  expect(
    within(dialog).queryByText("Where should the presenter stand?"),
  ).toBeNull();
  click(buttonContaining(dialog, "No voiceover"));
  await clickDialogButton(dialog, "Next");
  await expect(
    within(dialog).findByText("Review your intro video"),
  ).resolves.toBeVisible();
  await expect(within(dialog).findByText("No avatar")).resolves.toBeVisible();
  expect(within(dialog).queryByText(/Presenter on the left/u)).toBeNull();
  expect(within(dialog).queryByText(/Presenter on the right/u)).toBeNull();
});

test("Leaving the presenter step discards an uploaded deck", async () => {
  const user = userEvent.setup({ delay: null });
  installIntroVideoFixture();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: true },
  });

  const dialog = await openIntroVideoDialog();
  await uploadLaunchPresentation(user, dialog);
  await clickDialogButton(dialog, "Back");

  await expect(
    within(dialog).findByText("How do you want to start?"),
  ).resolves.toBeVisible();
  expect(buttonContaining(dialog, "Avatar")).toBeDisabled();
  expect(buttonContaining(dialog, "Voice")).toBeDisabled();
  expect(within(dialog).queryByText("launch.pdf")).toBeNull();
});

test("A generic source file opens at the presenter", async () => {
  const user = userEvent.setup({ delay: null });
  installIntroVideoFixture();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: true },
  });

  const dialog = await openIntroVideoDialog();
  const input = dialog.querySelector<HTMLInputElement>(
    '[data-intro-video-file-input=""]',
  );
  if (!input) {
    throw new Error("Intro-video file input not found");
  }
  await user.upload(
    input,
    new File(["speaker notes"], "speaker-notes.txt", {
      type: "text/plain",
    }),
  );

  await expect(
    within(dialog).findByText("Choose an avatar"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByText("Your source is ready")).toBeNull();
});

test("A presentation video request does not invent editing direction, opening, or ending", async () => {
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
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: true },
  });

  const dialog = await openIntroVideoDialog();
  await reviewWithoutAvatar(user, dialog);
  expect(within(dialog).getByLabelText("Editing instructions")).toHaveValue("");

  await clickDialogButton(dialog, "Create in chat");

  await waitFor(() => {
    expect(submittedPrompt).toBeDefined();
  });
  expect(submittedPrompt).toContain(
    "Create a polished video from the attached source.",
  );
  expect(submittedPrompt).toContain(
    "Do not add an opening or ending unless the user explicitly requests them.",
  );
  expect(submittedPrompt).not.toContain(
    "Create a polished intro video from the attached source.",
  );
  expect(submittedPrompt).not.toContain("Editing direction:");
  expect(submittedPrompt).not.toContain("<intro_video_workflow>");
  expect(submittedPrompt).not.toContain("okou presentation screenshot");
  expect(submittedPrompt).not.toContain("<user_request>");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

test("A selected Intro Video voice comes from HeyGen and is reused for lip sync", async () => {
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
  });

  const dialog = await openIntroVideoDialog();
  await uploadLaunchPresentation(user, dialog);
  click(
    await within(dialog).findByLabelText(
      "Select template Abigail Office Front",
    ),
  );
  await clickDialogButton(dialog, "Next");
  await expect(
    within(dialog).findByText("Choose a voice"),
  ).resolves.toBeVisible();
  expect(
    dialog.querySelector('[data-intro-video-voice-provider="heygen"]'),
  ).not.toBeNull();
  click(await within(dialog).findByLabelText("Select voice Annie - Lifelike"));
  await clickDialogButton(dialog, "Next");
  await expect(
    within(dialog).findByText("Review your intro video"),
  ).resolves.toBeVisible();
  expect(within(dialog).getByText("Annie - Lifelike")).toBeVisible();

  await clickDialogButton(dialog, "Create in chat");

  await waitFor(() => {
    expect(submittedPrompt).toContain(
      "- Voice: Annie - Lifelike (330290724a1b470fb63153f34d4c0183)",
    );
  });
  expect(submittedPrompt).toContain(
    "okou __intro-video-voice --voice-id 330290724a1b470fb63153f34d4c0183 --text <final-narration-script> --json",
  );
  expect(submittedPrompt).toContain(
    "use the command's returned permanent audio URL for presenter lip sync and reuse that exact audio in the final mix",
  );
  expect(submittedPrompt).toContain(
    "okou __intro-video-presenter --avatar-id Abigail_standing_office_front --audio-url <resolved-audio-url> --json",
  );
  expect(submittedPrompt).toContain("- Avatar provider: heygen");
  expect(submittedPrompt).toContain("output_format webm and Avatar III");
  expect(submittedPrompt).not.toContain("Avatar IV");
  expect(submittedPrompt).not.toContain("voice's owning provider");
  expect(submittedPrompt).not.toContain(
    "never send the catalog voice ID as a HeyGen voice_id",
  );
});

test("Pass the user's intro-video editing direction to the new chat", async () => {
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
    featureSwitches: { [FeatureSwitchKey.IntroVideo]: true },
  });

  const dialog = await openIntroVideoDialog();
  await reviewWithoutAvatar(user, dialog);
  await user.type(
    within(dialog).getByLabelText("Editing instructions"),
    "Keep the pacing brisk and end on the launch date.",
  );

  await clickDialogButton(dialog, "Create in chat");

  await waitFor(() => {
    expect(submittedPrompt).toContain("Editing direction:");
    expect(submittedPrompt).toContain(
      "Keep the pacing brisk and end on the launch date.",
    );
  });
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

test("Screen recording hands the user off to the desktop app", async () => {
  installIntroVideoFixture();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat`,
    featureSwitches: INTRO_VIDEO_SWITCHES,
  });

  const dialog = await openIntroVideoDialog();
  click(buttonContaining(dialog, "Record your screen"));

  await expect(
    within(dialog).findByText("Start a recording from the menu bar"),
  ).resolves.toBeVisible();
  expect(
    within(dialog).getByText("Come back to this wizard automatically"),
  ).toBeVisible();
  const download = await findFastControl("link", "Download for macOS", dialog);
  expect(download).toHaveAttribute(
    "href",
    expect.stringContaining("/api/desktop/updates/stable/darwin/arm64/dmg"),
  );

  await clickDialogButton(dialog, "Back");
  await expect(
    within(dialog).findByText("How do you want to start?"),
  ).resolves.toBeVisible();
});

test("A desktop recording video request does not invent an opening or ending", async () => {
  let submittedPrompt: string | undefined;
  installIntroVideoFixture({
    onSendRequest(body) {
      submittedPrompt = body.prompt;
    },
  });
  resolveDesktopRecordingFiles();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat?${new URLSearchParams(DESKTOP_HANDOFF_PARAMS).toString()}`,
    featureSwitches: INTRO_VIDEO_SWITCHES,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Create an intro video",
  });
  await expect(
    within(dialog).findByText("Your source is ready"),
  ).resolves.toBeVisible();
  await clickDialogButton(dialog, "Next");
  await expect(
    within(dialog).findByText("Choose an avatar"),
  ).resolves.toBeVisible();
  await reviewSourceWithoutAvatar(dialog, "Original audio");

  await clickDialogButton(dialog, "Create in chat");

  await waitFor(() => {
    expect(submittedPrompt).toBeDefined();
  });
  expect(submittedPrompt).toContain(
    "Create a polished video from the attached source.",
  );
  expect(submittedPrompt).toContain(
    "Do not add an opening or ending unless the user explicitly requests them.",
  );
  expect(submittedPrompt).not.toContain(
    "Create a polished intro video from the attached source.",
  );
  expect(submittedPrompt).toContain("- Source: demo.mp4");
  expect(submittedPrompt).not.toContain("<intro_video_workflow>");
  expect(submittedPrompt).not.toContain("okou video camera");
  expect(submittedPrompt).not.toContain("<user_request>");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

test("A desktop recording survives leaving the presenter step", async () => {
  installIntroVideoFixture();
  resolveDesktopRecordingFiles();

  await setupPage({
    context,
    path: `/agents/${MESSAGE_EXPERIENCE_AGENT_ID}/chat?${new URLSearchParams(DESKTOP_HANDOFF_PARAMS).toString()}`,
    featureSwitches: INTRO_VIDEO_SWITCHES,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Create an intro video",
  });
  await expect(
    within(dialog).findByText("Your source is ready"),
  ).resolves.toBeVisible();
  expect(within(dialog).getByText("demo.mp4")).toBeVisible();
  await clickDialogButton(dialog, "Next");
  await expect(
    within(dialog).findByText("Choose an avatar"),
  ).resolves.toBeVisible();

  await clickDialogButton(dialog, "Back");
  await expect(
    within(dialog).findByText("Your source is ready"),
  ).resolves.toBeVisible();
  expect(within(dialog).getByText("demo.mp4")).toBeVisible();

  click(buttonContaining(dialog, "Replace source"));
  await expect(
    within(dialog).findByText("How do you want to start?"),
  ).resolves.toBeVisible();
  click(buttonContaining(dialog, "Source"));
  await expect(
    within(dialog).findByText("Your source is ready"),
  ).resolves.toBeVisible();
  expect(within(dialog).getByText("demo.mp4")).toBeVisible();
});

test.each([true, false])(
  "A desktop recording reaches review after onboarding (needed: %s)",
  async (needsOnboarding) => {
    installIntroVideoFixture();
    resolveDesktopRecordingFiles();
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
    await expect(
      within(dialog).findByText("Your source is ready"),
    ).resolves.toBeVisible();
    expect(within(dialog).getByText("demo.mp4")).toBeVisible();
    await waitFor(() => {
      expect(search()).toBe("");
    });
  },
);
