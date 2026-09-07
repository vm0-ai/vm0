import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type {
  ChatRunOptionsRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { UserModelPreferenceResponse } from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey, VIDEO_TEMPLATE_ITEMS } from "@okouai/core";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  composerInlineTemplates,
  context,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  tabByText,
} from "./chat-composer-test-helpers.ts";

interface SubmittedMessage {
  readonly userMessage?: UserMessageDocument;
  readonly runOptions?: ChatRunOptionsRequest;
}

function installVideoEnvironment(): void {
  const preference: UserModelPreferenceResponse = {
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    selectedImageModel: "fal-ai/nano-banana-2",
    selectedVideoModel: "dreamina-seedance-2-0-260128",
    updatedAt: "2026-06-13T00:00:00.000Z",
  };
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.data.userModelPreference(preference);
  mockAgent();
  mockOrgModelRoutes("claude-fable-5-1");
  mockBillingCapabilities({
    supportByok: true,
    restrictedVm0Models: false,
  });
}

function pickerTrigger(label: string): HTMLElement {
  const trigger = screen.queryByRole("combobox", { name: label });
  if (!(trigger instanceof HTMLElement)) {
    throw new Error(`${label} composer model picker not found`);
  }
  return trigger;
}

function fastControl(
  role: "button" | "radio",
  label: string,
  container: ParentNode = document,
): HTMLElement {
  const control = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.trim() === label
    );
  });
  if (!control) {
    throw new Error(`${label} ${role} not found`);
  }
  return control;
}

async function enterVideoMode(triggerLabel: string): Promise<void> {
  await waitFor(() => {
    expect(pickerTrigger(triggerLabel)).toBeInTheDocument();
  });
  click(pickerTrigger(triggerLabel));
  await screen.findByRole("radiogroup", { name: "Models" });
  click(fastControl("radio", "Video"));
  await waitFor(() => {
    expect(fastControl("button", "Seedance 2.0")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
}

async function openVideoOptions(expectedSpec: string): Promise<HTMLElement> {
  const chip = await waitFor(() => {
    return fastControl("button", `Video options ${expectedSpec}`);
  });
  click(chip);
  return await screen.findByLabelText("Video options");
}

function optionRadio(group: HTMLElement, label: string): HTMLElement {
  const radio = queryAllByRoleFast("radio", group).find((candidate) => {
    return candidate.textContent?.trim() === label;
  });
  if (!radio) {
    throw new Error(`${label} video option not found`);
  }
  return radio;
}

function sendButton(): HTMLElement {
  const send = queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "Send";
  });
  if (!(send instanceof HTMLElement)) {
    throw new Error("Accessible Send button not found");
  }
  return send;
}

async function enterText(text: string): Promise<HTMLElement> {
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await fill(editor, text);
  await waitFor(() => {
    expect(editor).toHaveTextContent(text);
  });
  return editor;
}

async function sendCurrent(editor: HTMLElement, text: string): Promise<void> {
  const send = await waitFor(() => {
    expect(editor).toHaveTextContent(text);
    const currentSend = sendButton();
    expect(currentSend).toBeEnabled();
    return currentSend;
  });
  click(send);
}

async function selectVideoTemplate(): Promise<
  (typeof VIDEO_TEMPLATE_ITEMS)[number]
> {
  const template = VIDEO_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Video template catalog is empty");
  }
  click(
    await waitFor(() => {
      return fastControl("button", "Template");
    }),
  );
  await screen.findByRole("dialog");
  click(tabByText("Video"));
  await waitFor(() => {
    expect(
      fastControl("button", `Select video template ${template.title}`),
    ).toBeInTheDocument();
  });
  click(fastControl("button", `Select video template ${template.title}`));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      composerInlineTemplates().some((node) => {
        return node.textContent?.includes(template.title);
      }),
    ).toBeTruthy();
  });
  return template;
}

function videoTemplatePart(message: SubmittedMessage) {
  return message.userMessage?.parts.find((part) => {
    return part.type === "template" && part.template.type === "video";
  });
}

function installVideoSubmissionCapture(): SubmittedMessage[] {
  const submissions: SubmittedMessage[] = [];
  installVideoEnvironment();
  mockChatLifecycle(context, {
    onRunCreate: ({ userMessage, runOptions }) => {
      submissions.push({ userMessage, runOptions });
    },
  });

  return submissions;
}

test("Submit a video template with its default generation options", async () => {
  const user = userEvent.setup({ delay: null });
  const submissions = installVideoSubmissionCapture();
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const prompt = "Generate the first cinematic clip.";
  const editor = await enterText(prompt);
  await enterVideoMode("Claude Fable 5.1");
  const template = await selectVideoTemplate();
  await expect(
    openVideoOptions("16:9 · 8s · 720p"),
  ).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await sendCurrent(editor, prompt);

  await waitFor(() => {
    expect(submissions).toHaveLength(1);
    expect(editor).toHaveTextContent(/^$/u);
    expect(videoTemplatePart(submissions[0]!)).toStrictEqual({
      type: "template",
      titleSnapshot: template.title,
      template: {
        type: "video",
        selection: { stylePresetId: template.id },
      },
    });
    expect(submissions[0]?.runOptions).toBeUndefined();
  });
});

test("Submit the video ratio selected by the user", async () => {
  const user = userEvent.setup({ delay: null });
  const submissions = installVideoSubmissionCapture();
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const prompt = "Generate the portrait cinematic clip.";
  const editor = await enterText(prompt);
  await enterVideoMode("Claude Fable 5.1");
  const template = await selectVideoTemplate();
  const options = await openVideoOptions("16:9 · 8s · 720p");
  const ratioGroup = screen.getByRole("radiogroup", { name: "Ratio" });
  expect(options).toContainElement(ratioGroup);
  click(optionRadio(ratioGroup, "9:16"));
  await user.keyboard("{Escape}");
  await sendCurrent(editor, prompt);

  await waitFor(() => {
    expect(submissions).toHaveLength(1);
    expect(editor).toHaveTextContent(/^$/u);
    expect(videoTemplatePart(submissions[0]!)).toStrictEqual({
      type: "template",
      titleSnapshot: template.title,
      template: {
        type: "video",
        selection: { stylePresetId: template.id },
      },
    });
    expect(submissions[0]?.runOptions).toStrictEqual({
      video: { aspectRatio: "9:16" },
    });
  });
});

test("Keep the existing start cards when task entries are disabled", async () => {
  installVideoEnvironment();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskEntries]: false },
  });
  await screen.findByRole("textbox", { name: "Message" });
  await expect(screen.findByTestId("start-cards")).resolves.toBeVisible();
  expect(screen.queryByTestId("composer-task-entries")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Choose a task" }),
  ).not.toBeInTheDocument();
});

test("Start a workflow without overwriting the draft or sending on selection", async () => {
  const submissions = installVideoSubmissionCapture();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskEntries]: true },
  });
  const editor = await enterText("Summarize my inbox every morning.");
  const tasks = await screen.findByRole("group", { name: "Choose a task" });
  click(fastControl("button", "Workflow", tasks));
  await screen.findByText(
    "Describe the outcome and when it should run. Start with a draft.",
  );
  expect(editor).toHaveTextContent("Summarize my inbox every morning.");
  expect(submissions).toHaveLength(0);
  await sendCurrent(editor, "Summarize my inbox every morning.");
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.userMessage?.parts).toContainEqual({
      type: "text",
      text: "Create a reusable workflow for the following request. Use the workflow-setup skill and save a draft before setting up automation.\nSummarize my inbox every morning.",
    });
    expect(submissions[0]?.runOptions).toBeUndefined();
  });
});

test("Configure and submit a video directly from task entries on mobile", async () => {
  const submissions = installVideoSubmissionCapture();
  context.mocks.browser.matchMedia(() => {
    return false;
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskEntries]: true },
  });
  const editor = await enterText("A ceramic cup in the morning light.");
  const tasks = await screen.findByRole("group", { name: "Choose a task" });
  click(fastControl("button", "Video", tasks));
  const options = await screen.findByRole("group", { name: "Video options" });
  expect(options).toContainElement(
    screen.getByRole("combobox", { name: "Ratio" }),
  );
  click(screen.getByRole("combobox", { name: "Ratio" }));
  click(await screen.findByRole("option", { name: "9:16" }));
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Ratio" })).toHaveTextContent(
      "9:16",
    );
  });
  click(screen.getByRole("switch", { name: "Generate audio" }));
  await waitFor(() => {
    expect(
      screen.getByRole("switch", { name: "Generate audio" }),
    ).toHaveAttribute("aria-checked", "false");
  });
  await sendCurrent(editor, "A ceramic cup in the morning light.");
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.runOptions?.video?.aspectRatio).toBe("9:16");
    expect(submissions[0]?.runOptions?.video?.generateAudio).toBeFalsy();
    expect(submissions[0]?.userMessage?.parts).toContainEqual({
      type: "text",
      text: "Generate a video for the following request.\nA ceramic cup in the morning light.",
    });
  });
});

test("Clear the task and its video settings while preserving the user's message", async () => {
  const submissions = installVideoSubmissionCapture();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskEntries]: true },
  });
  const editor = await enterText("Keep this exact message.");
  const tasks = await screen.findByRole("group", { name: "Choose a task" });
  click(fastControl("button", "Video", tasks));
  await screen.findByRole("group", { name: "Video options" });
  click(screen.getByRole("combobox", { name: "Ratio" }));
  click(await screen.findByRole("option", { name: "9:16" }));
  click(fastControl("button", "Clear task"));
  await waitFor(() => {
    expect(fastControl("button", "Video", tasks)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
  expect(editor).toHaveTextContent("Keep this exact message.");
  expect(
    screen.queryByRole("group", { name: "Video options" }),
  ).not.toBeInTheDocument();
  await sendCurrent(editor, "Keep this exact message.");
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.userMessage?.parts).toContainEqual({
      type: "text",
      text: "Keep this exact message.",
    });
    expect(submissions[0]?.runOptions).toBeUndefined();
  });
});

test("Select a workflow starter with the existing structured template and preserve the draft", async () => {
  const submissions = installVideoSubmissionCapture();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskEntries]: true },
  });
  const editor = await enterText("Only include important messages.");
  await screen.findByRole("region", { name: "Let your work keep working" });
  click(fastControl("button", "Morning brief"));
  await waitFor(() => {
    expect(editor).toHaveTextContent("Morning brief");
  });
  expect(editor).toHaveTextContent("Only include important messages.");
  expect(submissions).toHaveLength(0);
  await sendCurrent(editor, "Only include important messages.");
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.userMessage?.parts).toContainEqual({
      type: "template",
      titleSnapshot: "Morning brief",
      template: {
        type: "workflow",
        selection: { workflowTemplateId: "workflow-template:morning-brief" },
      },
    });
  });
});

test("Changing from a workflow starter to video removes conflicting templates but keeps the draft", async () => {
  const submissions = installVideoSubmissionCapture();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskEntries]: true },
  });
  const editor = await enterText("Use my morning notes.");
  await screen.findByRole("region", { name: "Let your work keep working" });
  click(fastControl("button", "Morning brief"));
  await waitFor(() => {
    expect(editor).toHaveTextContent("Morning brief");
  });
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(fastControl("button", "Video", tasks));
  await screen.findByRole("group", { name: "Video options" });
  expect(editor).toHaveTextContent("Use my morning notes.");
  expect(editor).not.toHaveTextContent("Morning brief");
  await sendCurrent(editor, "Use my morning notes.");
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
    expect(
      submissions[0]?.userMessage?.parts.some((part) => {
        return part.type === "template";
      }),
    ).toBeFalsy();
    expect(submissions[0]?.userMessage?.parts).toContainEqual({
      type: "text",
      text: "Generate a video for the following request.\nUse my morning notes.",
    });
  });
});
