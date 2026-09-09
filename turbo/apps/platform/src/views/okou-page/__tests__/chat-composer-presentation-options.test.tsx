import { screen, waitFor, within } from "@testing-library/react";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import type {
  ChatRunOptionsRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
  context,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
} from "./chat-composer-test-helpers.ts";

interface SubmittedMessage {
  readonly userMessage?: UserMessageDocument;
  readonly runOptions?: ChatRunOptionsRequest;
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

function setupModels(): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  mockAgent();
  mockOrgModelRoutes("claude-fable-5-1");
  mockBillingCapabilities({ supportByok: true, restrictedVm0Models: false });
}

async function setupComposer(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ComposerCreateCommands]: true },
  });
  return await findComposerEditor();
}

async function enterPresentation(editor: HTMLElement): Promise<HTMLElement> {
  await fill(editor, "Our launch /create presentation");
  const menu = await screen.findByTestId("slash-workflow-menu");
  click(button("Create presentation", menu));
  return await screen.findByRole("combobox", { name: "Slide count" });
}

function visibleText(message: SubmittedMessage | undefined): string {
  return (
    message?.userMessage?.parts
      .flatMap((part) => {
        return part.type === "text" ? [part.text] : [];
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

test("Presentation offers six lengths without changing the submitted message", async () => {
  setupModels();
  const submissions: SubmittedMessage[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  const editor = await setupComposer();
  expect(screen.queryByRole("combobox", { name: "Slide count" })).toBeNull();
  const picker = await enterPresentation(editor);
  expect(picker).toHaveTextContent("8–12 slides");
  click(picker);
  const menu = await screen.findByRole("listbox");
  expect(
    within(menu)
      .getAllByRole("option")
      .map((item) => {
        return item.textContent?.trim();
      }),
  ).toStrictEqual([
    "Auto",
    "4–8 slides",
    "8–12 slides",
    "12–16 slides",
    "16–20 slides",
    "20–24 slides",
  ]);
  expect(
    within(menu).getByRole("option", { name: "8–12 slides" }),
  ).toHaveAttribute("aria-selected", "true");
  click(within(menu).getByRole("option", { name: "Auto" }));
  await waitFor(() => {
    expect(picker).toHaveTextContent("Auto");
  });
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(submissions[0]?.runOptions).toBeUndefined();
  expect(visibleText(submissions[0])).toBe("Our launch");
  expect(submissions[0]?.userMessage?.parts).toContainEqual({
    type: "additional_info",
    text: "Create a presentation.",
  });
  await expect(screen.findByText("Our launch")).resolves.toBeVisible();
});

test("Leaving presentation hides its picker and resets its length", async () => {
  setupModels();
  const submissions: SubmittedMessage[] = [];
  mockChatLifecycle(context, {
    onRunCreate: (body) => {
      submissions.push(body);
    },
  });
  const editor = await setupComposer();
  const picker = await enterPresentation(editor);
  click(picker);
  click(await screen.findByRole("option", { name: "Auto" }));
  await waitFor(() => {
    expect(picker).toHaveTextContent("Auto");
  });
  click(screen.getByRole("combobox", { name: "Choose a type" }));
  click(await screen.findByRole("option", { name: "Image" }));
  await screen.findByRole("combobox", { name: "Image models" });
  expect(screen.queryByRole("combobox", { name: "Slide count" })).toBeNull();
  click(screen.getByRole("combobox", { name: "Choose a type" }));
  click(await screen.findByRole("option", { name: "Presentation" }));
  await expect(
    screen.findByRole("combobox", { name: "Slide count" }),
  ).resolves.toHaveTextContent("8–12 slides");
  click(button("Exit create mode"));
  await waitFor(() => {
    expect(screen.queryByTestId("composer-create-mode")).toBeNull();
  });
  expect(screen.queryByRole("combobox", { name: "Slide count" })).toBeNull();
  click(button("Send"));
  await waitFor(() => {
    expect(submissions).toHaveLength(1);
  });
  expect(submissions[0]?.runOptions).toBeUndefined();
  expect(visibleText(submissions[0])).toBe("Our launch");
});
