import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { PRESENTATION_TEMPLATE_ITEMS } from "@vm0/core";
import {
  chatMessagesContract,
  type GenerationTemplateRequest,
} from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  detachedSetupPage,
  setupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);
const THREAD_ID = "thread-template-picker";
const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
const nextTemplate = PRESENTATION_TEMPLATE_ITEMS[1]!;

beforeEach(() => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    getItem: (key: string) => {
      return values.get(key) ?? null;
    },
    key: (index: number) => {
      return [...values.keys()][index] ?? null;
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("localStorage", storage);
});

function templateLabel(item: (typeof PRESENTATION_TEMPLATE_ITEMS)[number]) {
  const label = item.templateId
    .replace(/^template:/, "")
    .replace(/^html-ppt-/, "")
    .replace(/-/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function captureSendGenerationTemplate(options?: { gate?: Promise<void> }) {
  let capturedGenerationTemplate: GenerationTemplateRequest | undefined;
  server.use(
    mockApi(chatMessagesContract.send, async ({ body, respond }) => {
      if ("generationTemplate" in body) {
        capturedGenerationTemplate = body.generationTemplate;
      }
      if (options?.gate) {
        await options.gate;
      }
      return respond(201, {
        runId: "run-template-picker",
        threadId: body.threadId ?? THREAD_ID,
        status: "pending",
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
  return {
    generationTemplate: () => {
      return capturedGenerationTemplate;
    },
  };
}

function captureQueuedGenerationTemplate() {
  let capturedGenerationTemplate: GenerationTemplateRequest | undefined;
  return {
    onQueuedMessageAppend: (body: {
      generationTemplate?: GenerationTemplateRequest;
    }) => {
      capturedGenerationTemplate = body.generationTemplate;
    },
    generationTemplate: () => {
      return capturedGenerationTemplate;
    },
  };
}

async function openPickerAndSelectTemplate(
  user: ReturnType<typeof userEvent.setup>,
  item = template,
) {
  const templateButton = await waitFor(() => {
    return screen.getByLabelText("Template");
  });
  click(templateButton);

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  const pptTab = queryAllByRoleFast("tab").find((tab) => {
    return tab.textContent === "PPT";
  });
  expect(pptTab).toBeEnabled();

  await user.click(screen.getByLabelText(`Select template ${item.title}`));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Template")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  expect(
    screen.getByLabelText(`Remove template ${templateLabel(item)}`),
  ).toBeInTheDocument();
}

function expectPresentationTemplate(
  style: GenerationTemplateRequest | undefined,
) {
  expect(style).toStrictEqual({
    type: "presentation",
    selection: {
      designSystemId: template.designSystemId,
      templateId: template.templateId,
    },
  });
}

function expectTemplateChip(
  item: (typeof PRESENTATION_TEMPLATE_ITEMS)[number],
) {
  expect(
    screen.getByLabelText(`Remove template ${templateLabel(item)}`),
  ).toBeInTheDocument();
}

function tabWithText(text: string): HTMLElement | undefined {
  return queryAllByRoleFast("tab").find((tab) => {
    return tab.textContent === text;
  });
}

function buttonWithText(text: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return button.textContent === text;
  });
}

describe("zero chat template picker", () => {
  it("hides the Template button while the feature switch is off", async () => {
    mockChatLifecycle();

    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: false },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Attach")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Template")).not.toBeInTheDocument();
  });

  it("shows the Template button and opens the picker while enabled", async () => {
    mockChatLifecycle();

    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    const templateButton = await waitFor(() => {
      return screen.getByLabelText("Template");
    });
    click(templateButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByText(template.title)).toBeInTheDocument();
    expect(tabWithText("PPT")).toBeDefined();
    expect(tabWithText("Website")).toBeUndefined();
    expect(tabWithText("Illustration")).toBeUndefined();
    expect(tabWithText("Report")).toBeUndefined();
    expect(tabWithText("Workflow")).toBeUndefined();
    expect(buttonWithText("Clear")).toBeUndefined();
  });

  it("filters templates from the picker search", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    const templateButton = await waitFor(() => {
      return screen.getByLabelText("Template");
    });
    click(templateButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    await user.type(
      screen.getByLabelText("Search templates"),
      nextTemplate.title,
    );

    await waitFor(() => {
      expect(screen.getByText(nextTemplate.title)).toBeInTheDocument();
    });
    if (template.title !== nextTemplate.title) {
      expect(screen.queryByText(template.title)).toBeNull();
    }
  });

  it("shows the no-match empty state for template search", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    const templateButton = await waitFor(() => {
      return screen.getByLabelText("Template");
    });
    click(templateButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText("Search templates"), "no-match");

    await waitFor(() => {
      expect(screen.getByText("No matches")).toBeInTheDocument();
    });
    expect(screen.getByText("Try a different search.")).toBeInTheDocument();
    expect(screen.queryByText("My templates")).toBeNull();
    expect(screen.queryByText("Nothing saved yet")).toBeNull();
  });

  it("sends selected generation template from the new-thread composer and clears it", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();
    const sendCapture = captureSendGenerationTemplate();

    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    await openPickerAndSelectTemplate(user);

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Create a launch deck");

    await waitFor(() => {
      expectPresentationTemplate(sendCapture.generationTemplate());
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("does not clear a newer new-thread template when an older send resolves", async () => {
    const user = userEvent.setup();
    const sendGate = createDeferredPromise<void>(context.signal);
    mockChatLifecycle();
    const sendCapture = captureSendGenerationTemplate({
      gate: sendGate.promise,
    });

    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    await openPickerAndSelectTemplate(user, template);

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Create a launch deck");

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
    expectPresentationTemplate(sendCapture.generationTemplate());

    await openPickerAndSelectTemplate(user, nextTemplate);
    act(() => {
      sendGate.resolve();
    });

    await waitFor(() => {
      expectTemplateChip(nextTemplate);
    });
  });

  it("sends selected generation template from an existing-thread composer and clears it", async () => {
    const user = userEvent.setup();
    mockChatLifecycle({ threadId: THREAD_ID });
    const sendCapture = captureSendGenerationTemplate();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    await openPickerAndSelectTemplate(user);

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Use this style");

    await waitFor(() => {
      expectPresentationTemplate(sendCapture.generationTemplate());
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("clears the selected template from the chip", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    await setupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    await openPickerAndSelectTemplate(user);
    click(screen.getByLabelText("Template"));
    expect(buttonWithText("Clear")).toBeUndefined();
    await user.keyboard("{Escape}");

    await user.click(screen.getByLabelText("Remove template Pitch deck"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Remove template Pitch deck")).toBeNull();
    });
    expect(screen.getByLabelText("Template")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("queues selected generation template during an active run", async () => {
    const user = userEvent.setup();
    const queueCapture = captureQueuedGenerationTemplate();
    mockChatLifecycle({
      threadId: THREAD_ID,
      onQueuedMessageAppend: queueCapture.onQueuedMessageAppend,
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    const firstTextarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, firstTextarea, "Start a deck run");
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await openPickerAndSelectTemplate(user);
    const queuedTextarea = await waitFor(() => {
      return screen.getByPlaceholderText(
        /Type your next message/,
      ) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, queuedTextarea, "Queue a matching deck");

    await waitFor(() => {
      expectPresentationTemplate(queueCapture.generationTemplate());
    });
  });

  it("does not clear a newer queued template when an older queue request resolves", async () => {
    const user = userEvent.setup();
    const appendGate = createDeferredPromise<void>(context.signal);
    const queueCapture = captureQueuedGenerationTemplate();
    mockChatLifecycle({
      threadId: THREAD_ID,
      appendGate: appendGate.promise,
      onQueuedMessageAppend: queueCapture.onQueuedMessageAppend,
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    const firstTextarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, firstTextarea, "Start a deck run");
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await openPickerAndSelectTemplate(user, template);
    const queuedTextarea = await waitFor(() => {
      return screen.getByPlaceholderText(
        /Type your next message/,
      ) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, queuedTextarea, "Queue a matching deck");

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
    expectPresentationTemplate(queueCapture.generationTemplate());

    await openPickerAndSelectTemplate(user, nextTemplate);
    act(() => {
      appendGate.resolve();
    });

    await waitFor(() => {
      expectTemplateChip(nextTemplate);
    });
  });
});
