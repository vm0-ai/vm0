import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { avatarVideoContract } from "@okouai/api-contracts/contracts/avatar-video";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

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
  context.mocks.api(avatarVideoContract.voices, ({ respond }) => {
    return respond(200, {
      voices: [
        {
          id: "riley-en",
          name: "Riley",
          language: "English",
          gender: "female",
          age: "adult",
          useCase: "Narration",
        },
      ],
      hasMore: false,
      filterOptions: { languages: ["English"], useCases: ["Narration"] },
    });
  });
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
