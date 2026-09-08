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
  ILLUSTRATION_TEMPLATE_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
} from "../../../lib/platform-template-items.ts";
import {
  AGENT_ID,
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
        text: expect.stringContaining("Create a video."),
      }),
    ]),
  );
  expect(JSON.stringify(sent?.userMessage)).toContain(
    "A train crossing the mountains",
  );
  expect(sent?.runOptions?.video).toMatchObject({ aspectRatio: "9:16" });
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
  expect(JSON.stringify(submissions[0])).not.toContain(
    "Create a presentation.",
  );
  expect(submissions[0]?.parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      titleSnapshot: template.title,
    }),
  );
});
