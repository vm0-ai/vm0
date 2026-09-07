import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  agentInstructionsContract,
  agentsByIdContract,
} from "@okouai/api-contracts/contracts/agents";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const context = testContext();

function researchAgent() {
  return {
    agentId: AGENT_ID,
    avatarUrl: null,
    description: "Investigates release risks",
    displayName: "Research Agent",
    modelProviderId: null,
    ownerId: "test-user-123",
    preferPersonalProvider: false,
    selectedModel: null,
    sound: null,
    visibility: "private" as const,
  };
}

function setupInstructionsPage(
  initialContent: string,
  onUpdate?: (content: string) => void,
): Promise<void> {
  let savedContent = initialContent;
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, researchAgent());
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, {
      content: savedContent,
      filename: "AGENTS.md",
    });
  });
  context.mocks.api(agentInstructionsContract.update, ({ body, respond }) => {
    savedContent = body.content;
    onUpdate?.(body.content);
    return respond(200, researchAgent());
  });

  return setupPage({
    context,
    path: `/agents/${AGENT_ID}?tab=instructions`,
  });
}

async function instructionsEditor(): Promise<HTMLElement> {
  const editor = await screen.findByLabelText("Instructions editor");
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Expected the instructions editor");
  }
  return editor;
}

test("Markdown links retain their destination while remaining editable", async () => {
  await setupInstructionsPage(
    "Review the [Runbook](https://docs.example.test/runbook) before launch.",
  );

  const editor = await instructionsEditor();
  expect(editor).toHaveTextContent("Review the Runbook before launch.");
  const link = editor.querySelector("a");
  expect(link).toHaveAttribute("href", "https://docs.example.test/runbook");

  await userEvent.setup({ delay: null }).click(editor);
  expect(editor).toHaveFocus();
  expect(pathname()).toBe(`/agents/${AGENT_ID}`);
});

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected a browser selection");
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
}

function tabByName(name: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((element) => {
    return element.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`Expected ${name} tab`);
  }
  return tab;
}

async function saveAndReopenInstructions(): Promise<HTMLElement> {
  const unsavedBar = await screen.findByTestId("unsaved-bar");
  click(within(unsavedBar).getByTestId("save-button"));
  await waitFor(() => {
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
  });
  await expect(screen.findByText("Instructions saved")).resolves.toBeVisible();
  click(tabByName("Profile"));
  await waitFor(() => {
    expect(tabByName("Profile")).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByLabelText("Instructions editor"),
    ).not.toBeInTheDocument();
  });
  click(tabByName("Instructions"));
  return await instructionsEditor();
}

function expectStructuredInstructions(editor: HTMLElement): void {
  const link = editor.querySelector(
    'a[href="https://docs.example.test/runbook"]',
  );
  expect(link).toHaveTextContent("Runbook");
  expect(link).toHaveAttribute("title", "Launch guide");
  const diagram = within(editor).getByAltText("Architecture diagram");
  expect(diagram).toHaveAttribute(
    "src",
    "https://images.example.test/architecture.png",
  );
  expect(diagram).toHaveAttribute("title", "System overview");
  expect(
    within(editor).getByAltText("Inline diagram").parentElement,
  ).toHaveTextContent("Before image after image");
  const table = within(editor).getByRole("table");
  expect(table.querySelector("th")).toHaveTextContent("Name");
  expect(table.querySelector("td strong")).toHaveTextContent("Ready");
  expect(table.querySelector("td code")).toHaveTextContent("a|b");
  expect(table.querySelectorAll("th")[1]).toHaveStyle({ textAlign: "right" });
  const checkboxes = within(editor).getAllByRole("checkbox");
  expect(checkboxes).toHaveLength(2);
  expect(checkboxes[0]).toBeChecked();
  expect(checkboxes[1]).not.toBeChecked();
  expect(editor).toHaveTextContent("Nested follow-up");
}

test("An unrelated edit preserves tables, links, images and nested tasks after saving", async () => {
  const updates: string[] = [];
  const source = [
    '[Runbook](https://docs.example.test/runbook "Launch guide")',
    "",
    '![Architecture diagram](https://images.example.test/architecture.png "System overview")',
    "",
    "Before image ![Inline diagram](https://images.example.test/inline.png) after image",
    "",
    "| Name | Detail |",
    "| :--- | ---: |",
    "| **Ready** | `a|b` |",
    "",
    "- [x] Completed task",
    "  - [ ] Nested follow-up",
    "",
    "Edit only this paragraph.",
  ].join("\n");
  await setupInstructionsPage(source, (content) => {
    updates.push(content);
  });

  const editor = await instructionsEditor();
  expectStructuredInstructions(editor);
  const user = userEvent.setup({ delay: null });
  const paragraph = within(editor).getByText("Edit only this paragraph.");
  await user.click(paragraph);
  placeCaretAtEnd(paragraph);
  await user.paste(" Updated.");
  expect(paragraph).toHaveTextContent("Updated.");

  const reopened = await saveAndReopenInstructions();
  expectStructuredInstructions(reopened);
  expect(reopened).toHaveTextContent("Updated.");
  expect(updates).toHaveLength(1);
  expect(updates[0]).toContain(
    '[Runbook](https://docs.example.test/runbook "Launch guide")',
  );
  expect(updates[0]).toContain(
    '![Architecture diagram](https://images.example.test/architecture.png "System overview")',
  );
  expect(updates[0]).toContain("- [x] Completed task");
  expect(updates[0]).toContain("- [ ] Nested follow-up");
});

test("A task checkbox change survives saving and reopening instructions", async () => {
  await setupInstructionsPage(
    "- [ ] Review the launch\n- [x] Prepare the report",
  );
  const editor = await instructionsEditor();
  const checkbox = within(editor).getByRole("checkbox", {
    name: "Review the launch",
  });
  expect(checkbox).not.toBeChecked();
  click(checkbox);
  expect(checkbox).toBeChecked();

  const reopened = await saveAndReopenInstructions();
  const checkboxes = within(reopened).getAllByRole("checkbox");
  expect(checkboxes).toHaveLength(2);
  expect(checkboxes[0]).toBeChecked();
  expect(checkboxes[1]).toBeChecked();
});

test("Image-only instructions keep the image when a caption is added", async () => {
  await setupInstructionsPage(
    "![Diagram](https://images.example.test/diagram.png)",
  );
  const editor = await instructionsEditor();
  expect(within(editor).getByAltText("Diagram")).toBeVisible();
  const user = userEvent.setup({ delay: null });
  await user.click(editor);
  placeCaretAtEnd(editor);
  await user.paste(" Diagram caption.");

  const reopened = await saveAndReopenInstructions();
  expect(within(reopened).getByAltText("Diagram")).toHaveAttribute(
    "src",
    "https://images.example.test/diagram.png",
  );
  expect(reopened).toHaveTextContent("Diagram caption.");
});

test("A user can format and save agent instructions", async () => {
  const updates: string[] = [];
  await setupInstructionsPage("Review release notes", (content) => {
    updates.push(content);
  });
  const user = userEvent.setup({ delay: null });

  const editor = await instructionsEditor();
  expect(editor).toHaveTextContent("Review release notes");
  await fill(editor, "Launch risks");
  await user.click(editor);
  await user.keyboard("{Control>}a{/Control}");

  const formattingControls = [
    "Bold",
    "Italic",
    "Strikethrough",
    "Inline code",
    "Heading 1",
    "Heading 2",
    "Heading 3",
    "Bullet list",
    "Ordered list",
    "Blockquote",
  ] as const;
  for (const control of formattingControls) {
    await expect(screen.findByTitle(control)).resolves.toBeEnabled();
  }
  await user.click(screen.getByTitle("Heading 2"));
  expect(editor.querySelector("h2")).toHaveTextContent("Launch risks");

  const unsavedBar = await screen.findByTestId("unsaved-bar");
  click(within(unsavedBar).getByTestId("save-button"));

  await waitFor(() => {
    expect(updates).toHaveLength(1);
  });
  expect(updates[0]).toContain("## Launch risks");
  await waitFor(() => {
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
  });
  await expect(screen.findByText("Instructions saved")).resolves.toBeVisible();
  expect((await instructionsEditor()).querySelector("h2")).toHaveTextContent(
    "Launch risks",
  );
});
