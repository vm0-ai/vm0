import { HttpResponse } from "msw";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  uploadsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@okouai/core";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  composerInlineTemplates,
  context,
  expectInlineTemplateInComposer,
  findComposerEditor,
  mockActiveTemplateThread,
  mockAgent,
  mockComposerThreadSnapshot,
  mockThread,
  selectTemplate,
  THREAD_ID,
  workflowSummary,
} from "./chat-composer-test-helpers.ts";

const SPLIT_THREAD_ID = "b1000000-0000-4000-a000-000000000105";

type WorkflowFixture = ReturnType<typeof workflowSummary>;

function installWorkflows(read: () => readonly WorkflowFixture[]): {
  readonly requests: { readonly agentId: string | undefined }[];
} {
  const requests: { readonly agentId: string | undefined }[] = [];
  context.mocks.api(workflowsCollectionContract.list, ({ query, respond }) => {
    requests.push({ agentId: query.agentId });
    return respond(200, [...read()]);
  });
  return { requests };
}

function workflow(
  name: string,
  options: {
    readonly agentId?: string;
    readonly displayName?: string | null;
    readonly description?: string | null;
  } = {},
): WorkflowFixture {
  return workflowSummary({
    name,
    agentId: options.agentId ?? AGENT_ID,
    displayName: options.displayName ?? null,
    description: options.description ?? `${name} description`,
  });
}

function slashMenu(): HTMLElement {
  return screen.getByTestId("slash-workflow-menu");
}

function slashMenuButtons(): HTMLElement[] {
  return queryAllByRoleFast("button", slashMenu());
}

function slashButton(name: string): HTMLElement {
  const button = slashMenuButtons().find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim().startsWith(name);
  });
  if (!button) {
    throw new Error(`Expected slash workflow button ${name}`);
  }
  return button;
}

function templateTab(name: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`Expected template tab ${name}`);
  }
  return tab;
}

async function openTemplateCategory(
  category: string,
  templateLabel = "Template",
): Promise<void> {
  click(await screen.findByLabelText(templateLabel));
  await expect(screen.findByRole("dialog")).resolves.toBeVisible();
  click(templateTab(category));
}

function structuredTemplateReferences(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-structured-template-reference]",
    ),
  );
}

function workflowHighlights(editor: HTMLElement): HTMLElement[] {
  return Array.from(
    editor.querySelectorAll<HTMLElement>("span.text-brand-text"),
  );
}

function composerForThread(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  const composer = container?.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  );
  if (!composer) {
    throw new Error(`Expected composer for ${threadId}`);
  }
  return composer;
}

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected composer file input");
  }
  return input;
}

function namedButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button ${name}`);
  }
  return button;
}

function namedLink(name: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!link) {
    throw new Error(`Expected link ${name}`);
  }
  return link;
}

function installOffsetVisualViewport(): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), {
    width: 1024,
    height: 620,
    offsetLeft: 24,
    offsetTop: 160,
    pageLeft: 24,
    pageTop: 160,
    scale: 1,
    onresize: null,
    onscroll: null,
    onscrollend: null,
  });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(window, "visualViewport", descriptor);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    },
    { once: true },
  );
}

test("Compose a message with inline templates", async () => {
  const first = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  const second = PRESENTATION_TEMPLATE_PICKER_ITEMS[1];
  const replacement = PRESENTATION_TEMPLATE_PICKER_ITEMS[2];
  if (!first || !second || !replacement) {
    throw new Error("Expected at least three presentation templates");
  }
  let sentTemplateTitles: string[] = [];
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "My thread",
    onSendRequest: (body) => {
      sentTemplateTitles =
        body.userMessage?.parts.flatMap((part) => {
          return part.type === "template" ? [part.titleSnapshot] : [];
        }) ?? [];
    },
  });
  installWorkflows(() => {
    return [];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await expect(screen.findByLabelText("Template")).resolves.toBeVisible();

  await selectTemplate(user, first);
  await selectTemplate(user, second);
  expect(composerInlineTemplates()).toHaveLength(2);
  expect(editor.textContent).not.toContain("Ask me to automate");

  await user.click(editor);
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(sentTemplateTitles).toStrictEqual([first.title, second.title]);
    expect(structuredTemplateReferences()).toHaveLength(2);
  });
  expect(
    structuredTemplateReferences().map((reference) => {
      return reference.textContent;
    }),
  ).toStrictEqual([first.title, second.title]);
  expect(composerInlineTemplates()).toHaveLength(0);

  await selectTemplate(user, first);
  const inlineTemplate = composerInlineTemplates()[0];
  if (!inlineTemplate) {
    throw new Error("Expected an inline template to replace");
  }
  const inlineButton = queryAllByRoleFast("button", inlineTemplate)[0];
  if (!inlineButton) {
    throw new Error("Expected inline template button");
  }
  click(inlineButton);
  await expect(screen.findByRole("dialog")).resolves.toBeVisible();
  click(screen.getByLabelText(`Select template ${replacement.title}`));

  await waitFor(() => {
    const templates = composerInlineTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]).toHaveTextContent(replacement.title);
  });
});

test("Dismiss workflow suggestions without losing the query", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [workflow("sales-research")];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/sales");
  await expect(
    screen.findByTestId("slash-workflow-menu"),
  ).resolves.toBeVisible();

  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
    expect(editor).toHaveFocus();
    expect(editor).toHaveTextContent("/sales");
  });

  await user.keyboard("{ArrowLeft}{ArrowRight}");
  await expect(
    screen.findByTestId("slash-workflow-menu"),
  ).resolves.toBeVisible();
  const templateButton = screen.getByLabelText("Template");
  templateButton.focus();

  await waitFor(() => {
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
    expect(templateButton).toHaveFocus();
    expect(editor).toHaveTextContent("/sales");
  });
});

test("Navigate a long workflow suggestion list by keyboard", async () => {
  const workflows = Array.from({ length: 12 }, (_, index) => {
    return workflow(`task-${String(index + 1).padStart(2, "0")}`);
  });
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return workflows;
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/");
  await waitFor(() => {
    expect(slashMenuButtons()).toHaveLength(12);
  });
  const lastButton = slashButton("/task-12");
  const scrollCalls: ScrollIntoViewOptions[] = [];
  lastButton.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
    if (typeof options === "object") {
      scrollCalls.push(options);
    }
  };

  await user.keyboard("{ArrowDown}".repeat(11));

  await waitFor(() => {
    expect(lastButton).toHaveClass("bg-accent");
    expect(scrollCalls).toContainEqual({ block: "nearest" });
  });
  expect(editor).toHaveFocus();
});

test("Refresh workflow suggestions without disrupting the draft", async () => {
  let workflows: WorkflowFixture[] = [];
  const primaryThread = {
    id: THREAD_ID,
    agentId: AGENT_ID,
    title: "Primary workflow chat",
  };
  const splitThread = {
    id: SPLIT_THREAD_ID,
    agentId: AGENT_ID,
    title: "Split workflow chat",
  };
  mockAgent();
  mockThread();
  mockComposerThreadSnapshot([primaryThread, splitThread]);
  const traffic = installWorkflows(() => {
    return workflows;
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}?sidebar=${SPLIT_THREAD_ID}`,
  });

  const user = userEvent.setup();
  await waitFor(() => {
    expect(composerForThread(THREAD_ID)).toBeVisible();
    expect(composerForThread(SPLIT_THREAD_ID)).toBeVisible();
  });
  const primaryEditor = composerForThread(THREAD_ID);
  const splitEditor = composerForThread(SPLIT_THREAD_ID);
  await user.click(primaryEditor);
  await user.keyboard("/release-report");
  await waitFor(() => {
    expect(primaryEditor).toHaveTextContent("/release-report");
    expect(workflowHighlights(primaryEditor)).toHaveLength(0);
  });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadWorkflowsChanged:${THREAD_ID}`,
      ),
    ).toBeTruthy();
    expect(
      context.mocks.ably.hasSubscription(
        `chatThreadWorkflowsChanged:${SPLIT_THREAD_ID}`,
      ),
    ).toBeTruthy();
  });

  workflows = [workflow("release-report")];
  context.mocks.ably.trigger(`chatThreadWorkflowsChanged:${THREAD_ID}`);
  context.mocks.ably.trigger(`chatThreadWorkflowsChanged:${SPLIT_THREAD_ID}`);

  await waitFor(() => {
    expect(primaryEditor).toHaveTextContent("/release-report");
    expect(workflowHighlights(primaryEditor)).toHaveLength(1);
    expect(slashButton("/release-report")).toBeVisible();
  });

  workflows = [...workflows, workflow("first-live-change")];
  context.mocks.ably.trigger(`chatThreadWorkflowsChanged:${THREAD_ID}`);
  context.mocks.ably.trigger(`chatThreadWorkflowsChanged:${SPLIT_THREAD_ID}`);
  await waitFor(() => {
    expect(traffic.requests.length).toBeGreaterThanOrEqual(4);
  });
  workflows = [...workflows, workflow("latest-attached")];
  context.mocks.ably.trigger(`chatThreadWorkflowsChanged:${THREAD_ID}`);
  context.mocks.ably.trigger(`chatThreadWorkflowsChanged:${SPLIT_THREAD_ID}`);

  await user.click(primaryEditor);
  await user.keyboard(" /latest");
  await waitFor(() => {
    expect(slashButton("/latest-attached")).toBeVisible();
  });
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(primaryEditor).toHaveTextContent("/latest-attached");
  });

  await user.click(splitEditor);
  await user.keyboard("/latest");
  await waitFor(() => {
    expect(slashButton("/latest-attached")).toBeVisible();
  });
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(workflowHighlights(primaryEditor)).toHaveLength(2);
    expect(workflowHighlights(splitEditor)).toHaveLength(1);
    expect(splitEditor).toHaveTextContent("/latest-attached");
  });
});

test("Browse workflow templates in the user's language", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [];
  });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    locale: "pt-BR",
  });

  await findComposerEditor();
  await openTemplateCategory("Fluxo de trabalho", "Modelo");

  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByRole("textbox", { name: "Buscar modelos" }),
  ).toBeVisible();
  const selectedAllCategory = queryAllByRoleFast("button", dialog).find(
    (button) => {
      return (
        button.textContent?.trim() === "Todos" &&
        button.getAttribute("aria-pressed") === "true"
      );
    },
  );
  expect(selectedAllCategory).toBeVisible();
  expect(
    within(dialog).getByText("Marcador automático da caixa de entrada"),
  ).toBeVisible();
  expect(
    within(dialog).getByText(
      "Crie um fluxo que roda quando um marcador do Gmail é aplicado e cuida da mensagem marcada.",
    ),
  ).toBeVisible();
  expect(within(dialog).getAllByText("Usar").length).toBeGreaterThan(0);
});

test("Insert an attached workflow with slash suggestions", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("sales-research", { description: "Research qualified leads" }),
      workflow("support-escalation", {
        description: "Escalate support cases",
      }),
      workflow("research-digest", { description: "Digest research" }),
      workflow("organization-only", {
        agentId: "e0000000-0000-4000-a000-000000000099",
      }),
    ];
  });
  installOffsetVisualViewport();

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/");

  await waitFor(() => {
    expect(slashButton("/sales-research")).toBeVisible();
    expect(slashButton("/support-escalation")).toBeVisible();
    expect(screen.queryByText("/organization-only")).toBeNull();
  });

  await user.keyboard("ReSeArCh");
  const prefix = await waitFor(() => {
    return slashButton("/research-digest");
  });
  const substring = slashButton("/sales-research");
  expect(
    prefix.compareDocumentPosition(substring) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const emphasizedMatch = slashButton("/sales-research").querySelector(
    String.raw`span.text-brand-text\/60`,
  );
  expect(emphasizedMatch).toHaveTextContent("research");

  await user.keyboard("{ArrowDown}{Enter}");

  await waitFor(() => {
    expect(editor).toHaveTextContent("/sales-research");
    expect(workflowHighlights(editor)).toHaveLength(1);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
  expect(window.visualViewport?.offsetTop).toBe(160);
});

test("Send a template while the current run is active", async () => {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  mockAgent();
  mockActiveTemplateThread();
  installWorkflows(() => {
    return [];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  await findComposerEditor();
  await expect(
    screen.findByText("Start an active deck run"),
  ).resolves.toBeVisible();
  await selectTemplate(user, template);
  await waitFor(() => {
    expect(namedButton("Send")).toBeEnabled();
  });
  click(namedButton("Send"));

  await waitFor(() => {
    expect(composerInlineTemplates()).toHaveLength(0);
    expect(screen.getByTitle(`Presentation · ${template.title}`)).toBeVisible();
  });
  expect((await findComposerEditor()).textContent).toBe("");
});

test("Find and send a workflow template", async () => {
  const template = WORKFLOW_TEMPLATE_ITEMS.find((item) => {
    return item.id === "workflow-template:github-pr-summarizer";
  });
  if (!template) {
    throw new Error("Expected the GitHub PR summarizer workflow template");
  }
  let sentTemplateTitle: string | undefined;
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Workflow templates",
    onSendRequest: (body) => {
      sentTemplateTitle = body.userMessage?.parts.find((part) => {
        return part.type === "template";
      })?.titleSnapshot;
    },
  });
  installWorkflows(() => {
    return [];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await openTemplateCategory("Workflow");
  const search = screen.getByRole("textbox", { name: "Search templates" });
  await user.type(search, "merged pull requests");
  click(
    await screen.findByLabelText(`Select workflow template ${template.title}`),
  );

  await expectInlineTemplateInComposer(template.title);
  await user.click(editor);
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(sentTemplateTitle).toBe(template.title);
    expect(
      structuredTemplateReferences().some((reference) => {
        return reference.textContent === template.title;
      }),
    ).toBeTruthy();
  });
});

test("Continue from empty slash suggestions to all workflows", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [
      workflow("organization-catalog-workflow", {
        agentId: "e0000000-0000-4000-a000-000000000099",
      }),
    ];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  await user.click(editor);
  await user.keyboard("/");
  await expect(
    screen.findByText("No matching workflows"),
  ).resolves.toBeVisible();

  click(namedLink("View all workflows"));

  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
});

test("Wait for a template attachment before sending", async () => {
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  const uploadId = "a1000000-0000-4000-a000-000000000901";
  const uploadUrl = `https://mock-upload.r2.test/${uploadId}`;
  const publicUrl = `https://cdn.vm7.io/chat/${uploadId}/brief.txt`;
  const uploadGate = context.mocks.deferred<void>();
  let sends = 0;
  mockAgent();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Template upload",
    onSendRequest: () => {
      sends += 1;
    },
  });
  installWorkflows(() => {
    return [];
  });
  context.mocks.api(uploadsContract.prepare, ({ body, respond }) => {
    return respond(200, {
      id: uploadId,
      filename: body.filename,
      contentType: body.contentType,
      size: body.size,
      url: publicUrl,
      uploadUrl,
      uploadHeaders: {},
    });
  });
  context.mocks.http.put(uploadUrl, async ({ withSignal }) => {
    await withSignal(uploadGate.promise);
    return new HttpResponse(null, { status: 200 });
  });
  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  await findComposerEditor();
  await selectTemplate(user, template);
  const file = new File(["launch brief"], "brief.txt", {
    type: "text/plain",
  });
  fireEvent.change(composerFileInput(), { target: { files: [file] } });
  await expect(screen.findByText("brief.txt")).resolves.toBeVisible();
  await waitFor(() => {
    expect(namedButton("Cancel upload brief.txt")).toBeVisible();
    expect(namedButton("Send")).toBeDisabled();
  });

  click(namedButton("Send"));
  expect(sends).toBe(0);

  uploadGate.resolve();

  await waitFor(() => {
    expect(namedButton("Remove brief.txt")).toBeVisible();
    expect(namedButton("Send")).toBeEnabled();
    expect(screen.getByText("brief.txt")).toBeVisible();
    expect(composerInlineTemplates()).toHaveLength(1);
  });
});

test("Distinguish workflow tokens from text inside URLs", async () => {
  mockAgent();
  mockThread();
  installWorkflows(() => {
    return [workflow("pr-review")];
  });

  await setupPage({ context, path: `/chats/${THREAD_ID}` });

  const user = userEvent.setup();
  const editor = await findComposerEditor();
  const url = "https://www.vm0.ai/en/use-cases/pr-review";
  await user.click(editor);
  await user.keyboard(url);

  await waitFor(() => {
    expect(editor).toHaveTextContent(url);
    expect(workflowHighlights(editor)).toHaveLength(0);
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  });
});
