import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import {
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
} from "@okouai/core/image-model-catalog";
import type {
  UserMessageDocument,
  ChatRunOptionsRequest,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-lifecycle-test-helpers.ts";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
import {
  AGENT_ID,
  THREAD_ID,
  composerInlineTemplates,
  context,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  selectTemplate,
} from "./chat-composer-test-helpers.ts";

function setupModels(): void {
  mockAgent();
  mockOrgModelRoutes("claude-fable-5-1");
  mockBillingCapabilities({ supportByok: true, restrictedVm0Models: false });
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    selectedImageModel: "gpt-image-2",
    selectedVideoModel: "dreamina-seedance-2-0-260128",
    updatedAt: "2026-09-07T00:00:00.000Z",
  });
}

function button(label: string, container: ParentNode = document): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((item) => {
    return (
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label
    );
  });
  if (!result) {
    throw new Error(`Expected button ${label}`);
  }
  return result;
}

async function setupComposer(enabled = true): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerCreateCommands]: enabled },
  });
  return await findComposerEditor();
}

async function chooseCommand(
  editor: HTMLElement,
  text: string,
  label: string,
): Promise<void> {
  await fill(editor, text);
  const menu = await screen.findByTestId("slash-workflow-menu");
  click(button(label, menu));
  await waitFor(() => {
    expect(screen.getByTestId("composer-create-mode")).toHaveTextContent(label);
  });
}

test("Create commands stay hidden until enabled", async () => {
  setupModels();
  const editor = await setupComposer(false);
  await fill(editor, "/");
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  expect(screen.queryByTestId("composer-create-mode")).toBeNull();
});

test("Choose a video through the consolidated Create entry with the keyboard and submit its settings", async () => {
  setupModels();
  const submissions: {
    userMessage?: UserMessageDocument;
    runOptions?: ChatRunOptionsRequest;
  }[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  await fill(editor, "A train crossing the mountains /create");
  const menu = await screen.findByTestId("slash-workflow-menu");
  expect(button("Create", menu)).toBeInTheDocument();
  await user.keyboard("{Enter}");
  const types = await screen.findByRole("group", { name: "Choose a type" });
  expect(
    queryAllByRoleFast("button", types).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual(["Presentation", "Video", "Image"]);
  expect(button("Presentation", types)).toHaveFocus();
  expect(button("Send")).toBeDisabled();
  await user.keyboard("{ArrowRight}{Enter}");
  await waitFor(() => {
    expect(screen.getByTestId("composer-create-mode")).toHaveTextContent(
      "Create video",
    );
  });
  expect(types).not.toBeInTheDocument();
  expect(editor).toHaveTextContent("A train crossing the mountains");
  expect(editor).not.toHaveTextContent("/create");
  expect(submissions).toHaveLength(0);
  const videoPicker = await screen.findByRole("combobox", {
    name: "Video models",
  });
  expect(videoPicker).toHaveTextContent("Seedance 2.0");
  click(screen.getByRole("combobox", { name: "Ratio" }));
  click(await screen.findByRole("option", { name: "9:16" }));
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Ratio" })).toHaveTextContent(
      "9:16",
    );
  });
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  const sent = submissions[0];
  expect(sent?.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/^A train crossing the mountains\s*$/),
      }),
      {
        type: "additional_info",
        text: expect.stringContaining("Create a video."),
      },
    ]),
  );
  expect(JSON.stringify(sent?.userMessage)).toContain(
    "A train crossing the mountains",
  );
  expect(sent?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Aspect ratio: 9:16"),
  });
  expect(sent?.runOptions).toBeUndefined();
  await expect(
    screen.findByText("A train crossing the mountains"),
  ).resolves.toBeVisible();
});

test.each(["presentation", "video", "image"] as const)(
  "Persisted %s additional info stays out of the message and copied text",
  async (mode) => {
    setupModels();
    const clipboard = context.mocks.browser.clipboardWrite();
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          role: "user",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "additional_info",
                text: `Create ${mode === "image" ? "an" : "a"} ${mode}.\nAdditional generation settings.`,
              },
              { type: "text", text: "Our launch brief" },
            ],
          },
          createdAt: "2026-09-07T00:00:00.000Z",
        },
      ],
    });
    await setupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ComposerCreateCommands]: true },
    });
    const text = await screen.findByText("Our launch brief");
    const message = text.closest<HTMLElement>('[data-role="user"]');
    if (!message) {
      throw new Error("Expected the user message");
    }
    expect(message).toBeVisible();
    expect(message).not.toHaveTextContent("Create");
    expect(message).not.toHaveTextContent("Additional generation settings");
    click(button("Copy message", message));
    const item = await readSingleRichClipboardWrite(clipboard);
    await expect(readClipboardItemText(item, "text/plain")).resolves.toBe(
      "Our launch brief",
    );
  },
);

test("A queued Create message keeps its intent separate from user-authored text", async () => {
  setupModels();
  const queued: UserMessageDocument[] = [];
  const runId = crypto.randomUUID();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [runId],
    chatEvents: [
      {
        role: "user",
        content: "Review the launch brief",
        runId,
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    onQueuedEventAppend: (body) => {
      if (body.userMessage) {
        queued.push(body.userMessage);
      }
    },
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerCreateCommands]: true },
  });
  await screen.findByText("Review the launch brief");

  const followupEditor = await findComposerEditor();
  const prompt = "Create a presentation. Keep these words in my message.";
  await chooseCommand(
    followupEditor,
    `${prompt} /create presentation`,
    "Create presentation",
  );
  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name: "20–24 slides" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent("20–24 slides");
  });
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(queued).toHaveLength(1);
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("Create a presentation."),
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 20-24"),
  });
  expect(
    queued[0]?.parts
      .filter((part) => {
        return part.type === "text";
      })
      .map((part) => {
        return part.text;
      })
      .join("")
      .trim(),
  ).toBe(prompt);
  await expect(screen.findByText(prompt)).resolves.toBeVisible();
  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name: "4–8 slides" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent("4–8 slides");
  });
  await fill(await findComposerEditor(), "A shorter follow-up");
  click(button("Send"));
  await waitFor(() => {
    expect(queued).toHaveLength(2);
  });
  expect(queued[1]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 4-8"),
  });
  expect(queued[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 20-24"),
  });
  await expect(screen.findByText("A shorter follow-up")).resolves.toBeVisible();
});

test("Image mode combines styles and image models while preserving the prompt", async () => {
  setupModels();
  const editor = await setupComposer();
  await chooseCommand(editor, "A quiet garden /create image", "Create image");
  expect(button("Add style")).toBeInTheDocument();
  const picker = await screen.findByRole("combobox", { name: "Image models" });
  click(picker);
  const model = PUBLIC_IMAGE_MODELS.find((candidate) => {
    return candidate !== "gpt-image-2";
  });
  if (!model) {
    throw new Error("Expected another public image model");
  }
  click(
    await screen.findByRole("option", {
      name: IMAGE_MODEL_CONFIGS[model].label,
    }),
  );
  await waitFor(() => {
    expect(picker).toHaveTextContent(IMAGE_MODEL_CONFIGS[model].label);
  });
  click(button("Exit create mode"));
  await screen.findByRole("combobox", { name: "Claude Fable 5.1" });
  expect(screen.queryByTestId("composer-create-mode")).toBeNull();
  expect(editor).toHaveTextContent("A quiet garden");
});

test("Image mode sends when the model menu is still open", async () => {
  setupModels();
  const user = userEvent.setup({ delay: null });
  const submissions: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.userMessage) {
        submissions.push(body.userMessage);
      }
    },
  });
  const editor = await setupComposer();
  await chooseCommand(editor, "A quiet garden /create image", "Create image");
  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
  const picker = screen.getByRole("combobox", { name: "Image models" });
  await user.click(picker);
  const modelListbox = await screen.findByRole("listbox");
  expect(modelListbox).toBeInTheDocument();
  const send = button("Send");
  await user.click(send);
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
});

test.each([
  {
    mode: "image",
    commandLabel: "Create image",
    pickerLabel: "Add style",
    selectLabel: "Select template",
    previewLabel: "Preview template",
    templates: ILLUSTRATION_TEMPLATE_ITEMS,
  },
  {
    mode: "video",
    commandLabel: "Create video",
    pickerLabel: "Add template",
    selectLabel: "Select video template",
    previewLabel: "Preview video template",
    templates: VIDEO_TEMPLATE_ITEMS,
  },
  {
    mode: "presentation",
    commandLabel: "Create presentation",
    pickerLabel: "Add template",
    selectLabel: "Select template",
    previewLabel: "Preview template",
    templates: PRESENTATION_TEMPLATE_PICKER_ITEMS,
  },
])(
  "$commandLabel adds multiple templates, edits only the clicked chip, and sends every reference",
  async ({
    mode,
    commandLabel,
    pickerLabel,
    selectLabel,
    previewLabel,
    templates,
  }) => {
    setupModels();
    const submissions: UserMessageDocument[] = [];
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        if (body.userMessage) {
          submissions.push(body.userMessage);
        }
      },
    });
    const editor = await setupComposer();
    const user = userEvent.setup({ delay: null });
    const [first, second, replacement] = templates;
    if (!first || !second || !replacement) {
      throw new Error(`Expected three ${mode} templates`);
    }
    await chooseCommand(editor, `Our launch /create ${mode}`, commandLabel);
    click(button(pickerLabel));
    await screen.findByRole("dialog");
    click(await screen.findByLabelText(`${selectLabel} ${first.title}`));
    await waitFor(() => {
      expect(composerInlineTemplates()).toHaveLength(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await user.paste(" for the cover. ");
    click(button(pickerLabel));
    await screen.findByRole("dialog");
    click(await screen.findByLabelText(`${selectLabel} ${second.title}`));
    await waitFor(() => {
      const chips = composerInlineTemplates();
      expect(chips).toHaveLength(2);
      expect(chips[0]).toHaveTextContent(first.title);
      expect(chips[1]).toHaveTextContent(second.title);
    });

    const firstChip = composerInlineTemplates()[0];
    if (!firstChip) {
      throw new Error("Expected the first inline template");
    }
    click(button(`${previewLabel} ${first.title}`, firstChip));
    await screen.findByRole("dialog");
    click(await screen.findByLabelText(`${selectLabel} ${replacement.title}`));
    await waitFor(() => {
      const chips = composerInlineTemplates();
      expect(chips).toHaveLength(2);
      expect(chips[0]).toHaveTextContent(replacement.title);
      expect(chips[1]).toHaveTextContent(second.title);
    });
    expect(editor).toHaveTextContent("Our launch");
    expect(editor).toHaveTextContent("for the cover.");
    expect(button(pickerLabel)).toBeInTheDocument();

    click(button("Send"));
    await waitFor(() => {
      expect(submissions).toHaveLength(1);
    });
    const parts = submissions[0]?.parts;
    expect(parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(
        `Create ${mode === "image" ? "an" : "a"} ${mode}.`,
      ),
    });
    expect(
      parts?.flatMap((part) => {
        return part.type === "template" ? [part.titleSnapshot] : [];
      }),
    ).toStrictEqual([replacement.title, second.title]);
    expect(JSON.stringify(parts)).toContain("Our launch");
    expect(JSON.stringify(parts)).toContain("for the cover.");
  },
);

test("Multiple templates keep a generic toolbar label and all references survive sending", async () => {
  setupModels();
  const submissions: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.userMessage) {
        submissions.push(body.userMessage);
      }
    },
  });
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  const [first, second] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first || !second) {
    throw new Error("Expected two presentation templates");
  }
  await selectTemplate(user, first);
  await selectTemplate(user, second);
  await user.click(editor);
  await user.paste(" /create presentation");
  const menu = await screen.findByTestId("slash-workflow-menu");
  click(button("Create presentation", menu));
  await waitFor(() => {
    expect(button("Add template")).toBeInTheDocument();
  });
  expect(composerInlineTemplates()).toHaveLength(2);
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(
    submissions[0]?.parts
      .filter((part) => {
        return part.type === "template";
      })
      .map((part) => {
        return part.titleSnapshot;
      }),
  ).toStrictEqual([first.title, second.title]);
});

test("Presentation adds another template when the draft already has one", async () => {
  setupModels();
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  const [first, second] = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  if (!first || !second) {
    throw new Error("Expected two presentation templates");
  }
  await selectTemplate(user, first);
  await user.click(editor);
  await user.paste(" /create presentation");
  const menu = await screen.findByTestId("slash-workflow-menu");
  click(button("Create presentation", menu));
  await waitFor(() => {
    expect(button("Add template")).toBeInTheDocument();
  });
  expect(composerInlineTemplates()).toHaveLength(1);
  click(button("Add template"));
  await screen.findByRole("dialog");
  click(await screen.findByLabelText(`Select template ${second.title}`));
  await waitFor(() => {
    const chips = composerInlineTemplates();
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent(first.title);
    expect(chips[1]).toHaveTextContent(second.title);
  });
});

test("The slash menu exposes one Create entry that opens the image style flow", async () => {
  setupModels();
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  await user.keyboard("/");
  const menu = await screen.findByTestId("slash-workflow-menu");
  expect(
    queryAllByRoleFast("button", menu).filter((item) => {
      return item.getAttribute("aria-label")?.startsWith("Create");
    }),
  ).toHaveLength(1);
  click(button("Create", menu));
  const types = await screen.findByRole("group", { name: "Choose a type" });
  click(button("Image", types));
  await waitFor(() => {
    expect(screen.getByTestId("composer-create-mode")).toHaveTextContent(
      "Create image",
    );
  });
  click(button("Add style"));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    const tab = queryAllByRoleFast("tab", dialog).find((item) => {
      return item.textContent?.trim() === "Illustration";
    });
    expect(tab).toHaveAttribute("aria-selected", "true");
  });
});

test("Canceling and switching Create preserve slash text and template references", async () => {
  setupModels();
  const submissions: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      if (body.userMessage) {
        submissions.push(body.userMessage);
      }
    },
  });
  const editor = await setupComposer();
  const user = userEvent.setup({ delay: null });
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  await selectTemplate(user, template);
  await user.click(editor);
  await user.paste("Our launch /create");
  const menu = await screen.findByTestId("slash-workflow-menu");
  click(button("Create", menu));
  const chooser = await screen.findByRole("group", {
    name: "Choose a type",
  });
  await user.click(editor);
  await user.keyboard("{Enter}");
  expect(chooser).toBeInTheDocument();
  expect(button("Send")).toBeDisabled();
  expect(submissions).toHaveLength(0);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(chooser).not.toBeInTheDocument();
  });
  expect(editor).toHaveTextContent("Our launch");
  expect(composerInlineTemplates()).toHaveLength(1);

  await user.paste(" /create");
  const reopened = await screen.findByTestId("slash-workflow-menu");
  click(button("Create", reopened));
  const types = await screen.findByRole("group", { name: "Choose a type" });
  click(button("Presentation", types));
  const chip = await screen.findByTestId("composer-create-mode");
  expect(chip).toHaveTextContent("Create presentation");
  expect(types).not.toBeInTheDocument();
  await user.paste(" /notes");
  click(screen.getByRole("combobox", { name: "Choose a type" }));
  click(await screen.findByRole("option", { name: "Image" }));
  await waitFor(() => {
    expect(chip).toHaveTextContent("Create image");
    expect(editor).toHaveFocus();
  });
  expect(editor).toHaveTextContent("Our launch /notes");
  expect(composerInlineTemplates()).toHaveLength(1);
  click(button("Exit create mode", chip));
  await waitFor(() => {
    expect(chip).not.toBeInTheDocument();
  });
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Our launch /notes");
  expect(composerInlineTemplates()).toHaveLength(1);
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(JSON.stringify(submissions[0])).toContain("Our launch");
  expect(submissions[0]?.parts).not.toContainEqual(
    expect.objectContaining({ type: "additional_info" }),
  );
  expect(submissions[0]?.parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      titleSnapshot: template.title,
    }),
  );
});
