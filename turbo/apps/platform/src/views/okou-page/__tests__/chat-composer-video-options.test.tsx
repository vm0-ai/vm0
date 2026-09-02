import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatRunOptionsRequest,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { UserModelPreferenceResponse } from "@okouai/api-contracts/contracts/user-model-preference";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
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
    selectedModel: "claude-fable-5",
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
  mockOrgModelRoutes("claude-fable-5");
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

async function sendCurrent(
  user: ReturnType<typeof userEvent.setup>,
  editor: HTMLElement,
  text: string,
): Promise<void> {
  const send = await waitFor(() => {
    expect(editor).toHaveTextContent(text);
    const currentSend = sendButton();
    expect(currentSend).toBeEnabled();
    return currentSend;
  });
  await user.click(send);
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

test("Keep video generation options under the user's control", async () => {
  const user = userEvent.setup({ delay: null });
  const submissions: SubmittedMessage[] = [];
  let createdThreadEvent: ChatThreadEvent | null = null;
  installVideoEnvironment();
  mockChatLifecycle(context, {
    threadId: "video-template-options",
    onThreadCreate: ({
      clientThreadId,
      eventId,
      modelSelection,
      serviceTier,
      imageModel,
      videoModel,
    }) => {
      if (!clientThreadId || !eventId) {
        throw new Error("New chat thread identifiers are required");
      }
      createdThreadEvent = {
        id: eventId,
        seqId: 10_000,
        kind: "created",
        chatThreadId: clientThreadId,
        agentId: AGENT_ID,
        title: "Video options thread",
        selectedModel: modelSelection.selectedModel,
        serviceTier: serviceTier ?? null,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
        selectedVideoModel: videoModel ?? null,
        selectedImageModel: imageModel ?? null,
        createdAt: "2026-06-13T00:00:00.000Z",
      };
    },
    onRunCreate: ({ userMessage, runOptions }) => {
      submissions.push({ userMessage, runOptions });
    },
    onQueuedEventAppend: ({ userMessage, runOptions }) => {
      submissions.push({ userMessage, runOptions });
    },
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    const event = createdThreadEvent;
    return respond(200, {
      events: event && event.seqId > (query.sinceSeqId ?? 0) ? [event] : [],
      hasMore: false,
    });
  });
  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const firstPrompt = "Generate the first cinematic clip.";
  const firstEditor = await enterText(firstPrompt);
  await enterVideoMode("Claude Fable 5");
  const firstTemplate = await selectVideoTemplate();
  await expect(
    openVideoOptions("16:9 · 8s · 720p"),
  ).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await sendCurrent(user, firstEditor, firstPrompt);

  await waitFor(() => {
    expect(submissions).toHaveLength(1);
    expect(firstEditor).toHaveTextContent(/^$/u);
    expect(videoTemplatePart(submissions[0]!)).toStrictEqual({
      type: "template",
      titleSnapshot: firstTemplate.title,
      template: {
        type: "video",
        selection: { stylePresetId: firstTemplate.id },
      },
    });
    expect(submissions[0]?.runOptions).toBeUndefined();
  });

  await expect(screen.findByText(firstPrompt)).resolves.toBeVisible();
  await expect(
    screen.findByRole("region", { name: "Chat thread" }),
  ).resolves.toBeVisible();
  changeChatThreadList();
  await waitFor(() => {
    expect(document.title).toContain("Video options thread");
  });
  const threadEditor = await screen.findByRole("textbox", { name: "Message" });
  expect(threadEditor).toBeVisible();
  expect(threadEditor).toHaveAttribute("contenteditable", "true");

  const secondPrompt = "Generate the portrait cinematic clip.";
  const secondEditor = await enterText(secondPrompt);
  await enterVideoMode("Claude Fable 5");
  const secondTemplate = await selectVideoTemplate();
  const options = await openVideoOptions("16:9 · 8s · 720p");
  const ratioGroup = screen.getByRole("radiogroup", { name: "Ratio" });
  expect(options).toContainElement(ratioGroup);
  click(optionRadio(ratioGroup, "9:16"));
  await user.keyboard("{Escape}");
  await sendCurrent(user, secondEditor, secondPrompt);

  await waitFor(() => {
    expect(submissions).toHaveLength(2);
    expect(secondEditor).toHaveTextContent(/^$/u);
    expect(videoTemplatePart(submissions[1]!)).toStrictEqual({
      type: "template",
      titleSnapshot: secondTemplate.title,
      template: {
        type: "video",
        selection: { stylePresetId: secondTemplate.id },
      },
    });
    expect(submissions[1]?.runOptions).toStrictEqual({
      video: { aspectRatio: "9:16" },
    });
  });
});
