import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { findComposerEditor, tabByText } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
  createUploadedTemplate,
  mockPresentationTemplateLibrary,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

function button(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
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

async function setupChips(enabled = true): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: enabled,
      [FeatureSwitchKey.ComposerCreateCommands]: false,
    },
  });
  return await findComposerEditor();
}

test("The original start cards remain when task chips are disabled", async () => {
  mockTemplateChat();
  await setupChips(false);
  expect(screen.getByTestId("start-cards")).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Tasks to get started" }),
  ).toBeNull();
});

test.each([
  { task: "Image", mode: "image", instruction: "Create an image." },
  { task: "Video", mode: "video", instruction: "Create a video." },
  {
    task: "Presentation",
    mode: "presentation",
    instruction: "Create a presentation.",
  },
])(
  "$task enters and submits the existing create mode with only the chip switch enabled",
  async ({ task, mode, instruction }) => {
    const capture = mockTemplateChat();
    const editor = await setupChips();
    const tasks = screen.getByRole("group", { name: "Choose a task" });
    await fill(editor, "My launch next week");
    click(button(task, tasks));
    await waitFor(() => {
      expect(screen.getByTestId("composer-create-mode")).toHaveTextContent(
        `Create ${mode}`,
      );
    });
    expect(button(task, tasks)).toHaveAttribute("aria-pressed", "true");
    expect(editor).toHaveTextContent("My launch next week");
    expect(capture.sentMessages).toHaveLength(0);
    click(button("Send"));
    await waitFor(() => {
      expect(capture.runPrompts).toHaveLength(1);
    });
    expect(capture.runPrompts).toStrictEqual(["My launch next week"]);
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining(instruction),
    });
    await expect(
      screen.findByText("My launch next week"),
    ).resolves.toBeVisible();
  },
);

test("Task changes preserve uploaded files and the draft, and toggling off restores ordinary chat", async () => {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000021",
    filename: "brief.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://cdn.example.test/brief.txt",
  });
  const user = userEvent.setup({ delay: null });
  const editor = await setupChips();
  await fill(editor, "Keep my draft");
  const upload = document.querySelector<HTMLInputElement>(
    'input[type="file"][multiple]',
  );
  if (!upload) {
    throw new Error("Expected composer upload input");
  }
  await user.upload(
    upload,
    new File(["brief"], "brief.txt", { type: "text/plain" }),
  );
  await screen.findByText("brief.txt");
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(button("Image", tasks));
  await screen.findByRole("combobox", { name: "Image models" });
  click(button("Video", tasks));
  await screen.findByRole("combobox", { name: "Video models" });
  click(screen.getByRole("combobox", { name: "Ratio" }));
  click(await screen.findByRole("option", { name: "9:16" }));
  click(button("Video", tasks));
  await screen.findByRole("combobox", { name: "Claude Sonnet 4.6" });
  expect(screen.queryByTestId("composer-create-mode")).toBeNull();
  expect(editor).toHaveTextContent("Keep my draft");
  expect(screen.getByText("brief.txt")).toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual(["Keep my draft"]);
  expect(capture.sentMessages[0]?.parts).toContainEqual(
    expect.objectContaining({ type: "file", filenameSnapshot: "brief.txt" }),
  );
});

test.each([
  {
    task: "Workflow",
    first: "Get my morning email brief",
    next: "Help me prepare for meetings",
    prompt: "Give me a morning brief",
    cycle: ["Help me prepare for meetings", "Get my morning email brief"],
  },
  {
    task: "Image",
    first: "Put my product in a new scene",
    next: "Make a photo ready for my store",
    prompt: "Put my product in a new scene.",
    cycle: [
      "Make a photo ready for my store",
      "Create an image for my website",
      "Put my product in a new scene",
    ],
  },
  {
    task: "Video",
    first: "Turn a photo into a video",
    next: "Explain an idea visually",
    prompt: "Animate a photo I provide",
    cycle: ["Explain an idea visually", "Turn a photo into a video"],
  },
  {
    task: "Website",
    first: "Build a website for my business",
    next: "Put my café menu online",
    prompt: "Build a website that explains my business",
    cycle: ["Put my café menu online", "Build a website for my business"],
  },
])(
  "$task ideas rotate without changing the draft and append without replacing it",
  async ({ task, first, next, prompt, cycle }) => {
    const capture = mockTemplateChat();
    const editor = await setupChips();
    const tasks = screen.getByRole("group", { name: "Choose a task" });
    if (task !== "Workflow") {
      click(button(task, tasks));
    }
    const ideas = await screen.findByRole("group", {
      name: "Ideas to get started",
    });
    await fill(editor, "Keep this context");
    click(button(first, ideas));
    await waitFor(() => {
      expect(editor).toHaveTextContent(prompt);
    });
    const draft = editor.textContent;
    click(button(first, ideas));
    expect(editor.textContent).toBe(draft);
    click(button("More ideas", ideas));
    await within(ideas).findByText(next);
    expect(within(ideas).queryByText(first)).toBeNull();
    expect(editor.textContent).toBe(draft);
    for (const label of cycle.slice(1)) {
      click(button("More ideas", ideas));
      await within(ideas).findByText(label);
      expect(editor.textContent).toBe(draft);
    }
    expect(editor).toHaveTextContent("Keep this context");
    expect(capture.sentMessages).toHaveLength(0);
  },
);

test("Slash commands and the create mode picker keep task chips in sync", async () => {
  mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "A quiet garden /create image");
  const menu = await screen.findByTestId("slash-workflow-menu");
  click(button("Create image", menu));
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  await waitFor(() => {
    expect(button("Image", tasks)).toHaveAttribute("aria-pressed", "true");
  });
  expect(editor).toHaveTextContent("A quiet garden");
  expect(editor).not.toHaveTextContent("/create image");
  click(screen.getByRole("combobox", { name: "Choose a type" }));
  click(await screen.findByRole("option", { name: "Video" }));
  await waitFor(() => {
    expect(button("Video", tasks)).toHaveAttribute("aria-pressed", "true");
  });
  expect(button("Image", tasks)).toHaveAttribute("aria-pressed", "false");
});

test("A presentation suggestion inserts a canonical template and preserves the prompt", async () => {
  const capture = mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Explain our product launch");
  click(
    button(
      "Presentation",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  const templates = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  expect(
    within(templates).getByLabelText("Import your own deck"),
  ).toHaveAttribute("accept", ".pptx,.ppt,.pdf");
  for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS.slice(0, 3)) {
    expect(button(item.title, templates)).toBeInTheDocument();
  }
  expect(
    queryAllByRoleFast("button", templates).some((item) => {
      return (
        item.textContent?.trim() ===
        PRESENTATION_TEMPLATE_PICKER_ITEMS[3]!.title
      );
    }),
  ).toBeFalsy();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
  click(button(template.title, templates));
  await waitFor(() => {
    expect(editor).toHaveTextContent(template.title);
  });
  expect(editor).toHaveTextContent("Explain our product launch");
  const slideCount = screen.getByRole("combobox", { name: "Slide count" });
  expect(slideCount).toHaveTextContent("8–12 slides");
  click(slideCount);
  click(await screen.findByRole("option", { name: "16–20 slides" }));
  await waitFor(() => {
    expect(slideCount).toHaveTextContent("16–20 slides");
  });
  expect(capture.sentMessages).toHaveLength(0);
  click(button("Send"));
  await waitFor(() => {
    expect(capture.selectedTemplates).toHaveLength(1);
  });
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "presentation",
    selection: {
      templateId: template.templateId,
      previewUrl: template.embedUrl,
    },
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 16-20"),
  });
});

test("Uploaded presentation suggestions use the existing template reference", async () => {
  const capture = mockTemplateChat();
  const deck = createUploadedTemplate({
    id: "81000000-0000-4000-a000-000000000022",
    title: "My brand deck",
    canManage: true,
  });
  mockPresentationTemplateLibrary([
    deck,
    ...[24, 25, 26].map((index) => {
      return createUploadedTemplate({
        id: `81000000-0000-4000-a000-0000000000${index}`,
        title: `My brand deck ${index}`,
        canManage: true,
      });
    }),
  ]);
  const editor = await setupChips();
  click(
    button(
      "Presentation",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  const templates = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  await within(templates).findByText("My brand deck");
  expect(
    queryAllByRoleFast("button", templates).filter((item) => {
      return item.textContent?.trim().startsWith("My brand deck");
    }),
  ).toHaveLength(3);
  click(button("My brand deck", templates));
  await waitFor(() => {
    expect(editor).toHaveTextContent("My brand deck");
  });
  click(button("Send"));
  await waitFor(() => {
    expect(capture.selectedTemplates).toHaveLength(1);
  });
  expect(capture.selectedTemplates[0]).toMatchObject({
    type: "presentation",
    selection: { templateId: `user-template:${deck.id}` },
  });
});

test("Importing a deck uses the existing analysis flow without a create-mode instruction", async () => {
  const capture = mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000023",
    filename: "brand.pdf",
    contentType: "application/pdf",
    size: 5,
    url: "https://cdn.example.test/brand.pdf",
  });
  const user = userEvent.setup({ delay: null });
  await setupChips();
  click(
    button(
      "Presentation",
      screen.getByRole("group", { name: "Choose a task" }),
    ),
  );
  const input = await screen.findByLabelText("Import your own deck");
  await user.upload(
    input,
    new File(["brand"], "brand.pdf", { type: "application/pdf" }),
  );
  await waitFor(() => {
    expect(capture.sentMessages).toHaveLength(1);
  });
  expect(capture.runPrompts).toStrictEqual([
    "Analyse this deck and save its visual language as a reusable presentation template.",
  ]);
  expect(capture.sentMessages[0]?.parts).toContainEqual(
    expect.objectContaining({ type: "file", filenameSnapshot: "brand.pdf" }),
  );
});

test("More templates and Website open the existing library in the matching category", async () => {
  mockTemplateChat();
  const editor = await setupChips();
  await fill(editor, "Keep my draft");
  const tasks = screen.getByRole("group", { name: "Choose a task" });
  click(button("Presentation", tasks));
  click(button("More templates"));
  const dialog = await screen.findByRole("dialog");
  expect(tabByText("Presentation")).toHaveAttribute("aria-selected", "true");
  click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(button("Website", tasks));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(button("Website", tasks)).toHaveAttribute("aria-pressed", "true");
  expect(
    queryAllByRoleFast("button", tasks).map((item) => {
      return item.textContent?.trim();
    }),
  ).not.toContain("More");
  await screen.findByText("Build a website for my business");
  click(button("More templates"));
  await screen.findByRole("dialog");
  expect(tabByText("Website")).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByTestId("composer-create-mode")).toBeNull();
  expect(editor).toHaveTextContent("Keep my draft");
});

test("Task chips do not replace the composer in an existing conversation", async () => {
  mockTemplateChat();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ComposerTaskChips]: true },
  });
  await findComposerEditor();
  expect(
    screen.queryByRole("region", { name: "Tasks to get started" }),
  ).toBeNull();
});

test("Starting ideas use the active app language", async () => {
  mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    locale: "ja-JP",
    featureSwitches: { [FeatureSwitchKey.ComposerTaskChips]: true },
  });
  const editor = await findComposerEditor();
  const idea = "毎朝、重要なメールをまとめる";
  click(button(idea));
  await waitFor(() => {
    expect(editor).toHaveTextContent("毎朝、注目すべきメール");
  });
});
