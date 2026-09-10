import { act, screen, within } from "@testing-library/react";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";
import {
  click,
  holdElementAnimations,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function button(name: string, container: ParentNode = document.body) {
  const element = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!element) {
    throw new Error(`Missing button: ${name}`);
  }
  return element;
}

async function openDebug(debug = true, welcome = true) {
  await setupPage({
    context,
    path: "/agents/c0000000-0000-4000-a000-000000000001/chat?settings=debug",
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: debug,
      [FeatureSwitchKey.WelcomeThread]: welcome,
    },
  });
  return await screen.findByRole("dialog", { name: "Settings" });
}

async function reopenDebug() {
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  click(within(await screen.findByRole("menu")).getByText("Settings"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(button("Debug", dialog));
  return await screen.findByRole("region", { name: "Welcome thread" });
}

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])("Debug %s and welcome %s gate the manual action", async (debug, welcome) => {
  const dialog = await openDebug(debug, welcome);
  expect(
    within(dialog).queryByRole("region", { name: "Welcome thread" }) !== null,
  ).toBe(debug && welcome);
  expect(
    within(dialog).getByRole("heading", {
      name: debug ? "Debug" : "Preference",
    }),
  ).toBeVisible();
});

test("Leaving the page cancels the pending action without opening its late result", async () => {
  const received = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    welcomeChatThreadsContract.create,
    async ({ request, respond }) => {
      request.signal.addEventListener(
        "abort",
        () => {
          return aborted.resolve();
        },
        { once: true },
      );
      received.resolve();
      await release.promise;
      return respond(201, { id: context.resourceId });
    },
  );
  await openDebug();
  click(button("Create welcome thread"));
  await received.promise;
  act(() => {
    window.history.pushState({}, "", "/agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("heading", { name: "Agents" });
  await aborted.promise;
  release.resolve();
  expect(window.location.pathname).toBe("/agents");
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
});

test.each([
  [
    409,
    "DEFAULT_AGENT_NOT_READY",
    "Configure the workspace default agent, then try again.",
  ],
  [409, "CONFLICT", "Could not create the welcome thread. Try again."],
  [403, "FORBIDDEN", "Could not create the welcome thread. Try again."],
  [404, "NOT_FOUND", "Could not create the welcome thread. Try again."],
] as const)(
  "A %s %s failure stays in Settings and permits retry",
  async (status, code, message) => {
    context.mocks.api(welcomeChatThreadsContract.create, ({ respond }) => {
      return respond(status, { error: { code, message } });
    });
    await openDebug();
    click(button("Create welcome thread"));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      message,
    );
    expect(button("Create welcome thread")).toBeEnabled();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(window.location.pathname).not.toMatch(/^\/chats\//);
  },
);

test.each(["success", "failure"] as const)(
  "Dismissal cancels a late %s before the close animation finishes",
  async (outcome) => {
    const received = context.mocks.deferred<void>();
    const aborted = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      welcomeChatThreadsContract.create,
      async ({ request, respond }) => {
        request.signal.addEventListener(
          "abort",
          () => {
            return aborted.resolve();
          },
          {
            once: true,
          },
        );
        received.resolve();
        await release.promise;
        return outcome === "success"
          ? respond(201, { id: context.resourceId })
          : respond(409, {
              error: { code: "CONFLICT", message: "Late conflict" },
            });
      },
    );
    const dialog = await openDebug();
    click(button("Create welcome thread"));
    await received.promise;
    const finishClose = holdElementAnimations(dialog);
    click(screen.getByLabelText("Close"));
    await aborted.promise;
    expect(dialog).toBeVisible();
    release.resolve();
    finishClose();
    await reopenDebug();
    expect(button("Create welcome thread")).toBeEnabled();
    expect(screen.queryByText("Late conflict")).toBeNull();
    expect(window.location.pathname).not.toMatch(/^\/chats\//);
  },
);
