import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  chatThreadPinContract,
  chatThreadUnpinContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000951";

async function setupHeaderPage(enabled = true) {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "😀 Header planning",
    chatEvents: [
      {
        id: "header-planning-prompt",
        role: "user",
        content: "Review the header layout",
        runId: "header-planning-run",
        createdAt: "2026-09-01T10:00:00Z",
      },
      {
        id: "header-planning-answer",
        role: "assistant",
        content: "The header layout is ready.",
        runId: "header-planning-run",
        createdAt: "2026-09-01T10:00:01Z",
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadHeaderActions]: enabled,
    },
  });
  await screen.findByText("Review the header layout");
  await waitFor(() => {
    expect(screen.getByLabelText("Change icon")).toHaveTextContent("😀");
  });
}

function buttonNamed(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function menuItemNamed(name: string) {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Menu item not found: ${name}`);
  }
  return item;
}

test.each([true, false])(
  "Keep the existing header when the switch is off (desktop: %s)",
  async (desktop) => {
    context.mocks.browser.matchMedia(desktop);
    await setupHeaderPage(false);
    expect(screen.queryByLabelText("Pin chat")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("More actions")).not.toBeInTheDocument();
    expect(buttonNamed("Share messages")).toBeInTheDocument();
    expect(
      buttonNamed(desktop ? "Open artifacts" : "Open mobile artifacts"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-thread-header-title")).toHaveLength(1);
  },
);

test("Pin optimistically, keep the pending action through resize, and undo", async () => {
  const viewport = context.mocks.browser.matchMedia(true);
  const pinResponse = context.mocks.deferred<void>();
  const pinRequests: string[] = [];
  const unpinRequests: string[] = [];
  context.mocks.api(chatThreadPinContract.pin, async ({ params, respond }) => {
    pinRequests.push(params.id);
    await pinResponse.promise;
    return respond(204);
  });
  context.mocks.api(chatThreadUnpinContract.unpin, ({ params, respond }) => {
    unpinRequests.push(params.id);
    return respond(204);
  });
  await setupHeaderPage();
  const title = screen.getByTestId("chat-thread-header-title");
  expect(title.closest("header")).toContainElement(buttonNamed("Pin chat"));

  click(buttonNamed("Pin chat"));
  await waitFor(() => {
    expect(buttonNamed("Unpin chat")).toBeDisabled();
    expect(buttonNamed("Unpin chat")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chat-thread-menu-trigger")).toHaveAttribute(
      "data-pinned",
      "true",
    );
  });
  act(() => {
    viewport.setMatches(false);
  });
  await waitFor(() => {
    expect(buttonNamed("More actions")).toBeInTheDocument();
    expect(buttonNamed("Unpin chat")).toBeDisabled();
  });
  expect(pinRequests).toStrictEqual([THREAD_ID]);
  pinResponse.resolve();
  await screen.findByText("Chat pinned");
  await waitFor(() => {
    expect(buttonNamed("Unpin chat")).toBeEnabled();
  });

  click(buttonNamed("Undo"));
  await screen.findByText("Chat unpinned");
  expect(unpinRequests).toStrictEqual([THREAD_ID]);
  expect(buttonNamed("Pin chat")).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByTestId("chat-thread-menu-trigger")).toHaveAttribute(
    "data-pinned",
    "false",
  );
});

test("Keep Pin, Share, and More in order and rename from the mobile menu", async () => {
  context.mocks.browser.matchMedia(false);
  await setupHeaderPage();
  const pin = buttonNamed("Pin chat");
  const group = pin.parentElement;
  if (!group) {
    throw new Error("Header action group is missing");
  }
  expect(
    queryAllByRoleFast("button", group).map((button) => {
      return button.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Pin chat", "Share messages", "More actions"]);
  expect(buttonNamed("Open menu")).toBeInTheDocument();
  expect(screen.queryByLabelText("Open artifacts")).not.toBeInTheDocument();

  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  expect(menuItemNamed("Artifacts")).toBeInTheDocument();
  click(menuItemNamed("Rename chat"));
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
    "😀 Header planning",
  );
});

test("Open artifacts from the mobile menu", async () => {
  context.mocks.browser.matchMedia(false);
  await setupHeaderPage();
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  click(menuItemNamed("Artifacts"));
  const artifacts = await screen.findByTestId("thread-sidebar-artifacts");
  expect(artifacts).toBeVisible();
});

test("Open linked automations from the mobile menu", async () => {
  context.mocks.browser.matchMedia(false);
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ respond }) => {
      return respond(200, [
        {
          id: "a0000000-0000-4000-a000-000000000951",
          ownerUserId: "test-user-123",
          enabled: true,
          chatThreadId: THREAD_ID,
          nextRunAt: null,
          lastRunAt: null,
          official: null,
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 7200 },
          scheduleSummary: "Every two hours",
          workflow: {
            id: "a0000000-0000-4000-a000-000000000952",
            agentId: "c0000000-0000-4000-a000-000000000001",
            name: "header-check",
            displayName: "Header check",
            description: null,
          },
        },
      ]);
    },
  );
  await setupHeaderPage();
  expect(screen.queryByLabelText("Open mobile automations")).toBeNull();
  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNamed("Automations")).toBeInTheDocument();
  });
  click(menuItemNamed("Automations"));
  const panel = await screen.findByRole("complementary", {
    name: "Automations",
  });
  const automation = await within(panel).findByText("Header check");
  expect(automation).toBeVisible();
});

test("Retain message selection and restore mobile actions after sharing", async () => {
  context.mocks.browser.matchMedia(false);
  await setupHeaderPage();
  click(buttonNamed("Share messages"));
  await screen.findAllByText("0 selected");
  expect(screen.queryByLabelText("Pin chat")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("More actions")).not.toBeInTheDocument();
  click(screen.getByText("Review the header layout"));
  await screen.findAllByText("1 selected");
  click(buttonNamed("Cancel"));
  await waitFor(() => {
    expect(buttonNamed("Pin chat")).toBeInTheDocument();
    expect(buttonNamed("More actions")).toBeInTheDocument();
  });
  click(buttonNamed("Change icon"));
  const search = await screen.findByLabelText("Search emoji");
  expect(search).toBeInTheDocument();
});

test("Explain uncertain persistence without undoing an optimistic pin", async () => {
  context.mocks.browser.matchMedia(true);
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(500, { error: { message: "Pin request failed" } });
  });
  await setupHeaderPage();
  click(buttonNamed("Pin chat"));
  const error = await screen.findByText(
    "Couldn’t confirm the pin change. Refresh to check its saved status.",
  );
  expect(error).toBeInTheDocument();
  expect(buttonNamed("Unpin chat")).toBeEnabled();
  expect(buttonNamed("Unpin chat")).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText("Chat pinned")).not.toBeInTheDocument();
});
