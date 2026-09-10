import { act, screen, waitFor, within } from "@testing-library/react";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  click,
  holdElementAnimations,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";
import { chatListEvent } from "./chat-list-test-helpers.ts";

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

test.each([false, true])(
  "A lost response retries the same UUID and opens the runless thread with token refresh=%s",
  async (refresh) => {
    const chat = createMarkdownChatFixture(context);
    const row = {
      ...chat.outputMessage("Hello from the persisted welcome", { seqId: 1 }),
      runId: null,
      runEventId: null,
      runEventSequenceNumber: null,
    };
    chat.install({
      rows: () => {
        return [row];
      },
    });
    let committed = false;
    const created = chatListEvent(33_294, 2, "created", chat.threadId, {
      agentId: "c0000000-0000-4000-a000-000000000071",
      title: "Recovered welcome",
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [],
        latestEventId: "d0000000-0000-4000-a000-000000000001",
        latestSeqId: 1,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      return respond(200, {
        events: committed && (query.sinceSeqId ?? 0) < 2 ? [created] : [],
        hasMore: false,
      });
    });
    context.mocks.data.agents([
      {
        agentId: "c0000000-0000-4000-a000-000000000001",
        displayName: "Default agent",
      },
      {
        agentId: "c0000000-0000-4000-a000-000000000071",
        displayName: "Markdown Agent",
      },
    ]);
    const release = context.mocks.deferred<void>();
    const received = context.mocks.deferred<void>();
    const requests: string[] = [];
    context.mocks.http.post(
      "*/api/welcome-chat-threads",
      async ({ request }) => {
        const body = welcomeChatThreadsContract.create.body.parse(
          await request.json(),
        );
        requests.push(body.clientThreadId);
        committed = true;
        if (requests.length === 1) {
          received.resolve();
          await release.promise;
          return HttpResponse.error();
        }
        return HttpResponse.json({ id: chat.threadId }, { status: 201 });
      },
    );
    await openDebug();
    const create = button("Create welcome thread");
    click(create);
    click(create);
    await received.promise;
    expect(button("Creating…")).toBeDisabled();
    if (refresh) {
      const clerk = context.mocks.clerk();
      act(() => {
        clerk.organization({
          activeOrg: null,
          memberships: [{ id: "org_default" }],
        });
        clerk.stateChanged();
      });
      act(() => {
        clerk.organization({
          activeOrg: { id: "org_default", name: "Default Org" },
          memberships: [{ id: "org_default" }],
        });
        clerk.stateChanged();
      });
    }
    release.resolve();
    await screen.findByRole("alert");
    click(button("Create welcome thread"));
    await waitFor(() => {
      expect(window.location.pathname).toBe(chat.path);
    });
    await screen.findByText("Hello from the persisted welcome");
    expect(window.location.pathname).toBe(chat.path);
    expect(
      new URL(window.location.href).searchParams.has("settings"),
    ).toBeFalsy();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[1]).toBe(requests[0]);
    expect(
      queryAllByRoleFast("link").some((link) => {
        return link.textContent?.includes("Recovered welcome");
      }),
    ).toBeTruthy();
    await reopenDebug();
    click(button("Create welcome thread"));
    await screen.findByText("Hello from the persisted welcome");
    await waitFor(() => {
      return expect(
        screen.queryByRole("dialog", { name: "Settings" }),
      ).toBeNull();
    });
    expect(requests[2]).not.toBe(requests[0]);
  },
);

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
  [
    409,
    "CONFLICT",
    "This request ID belongs to another chat. Close Settings and start a new welcome action.",
  ],
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

test("A workspace switch cancels the pending welcome action", async () => {
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
      return respond(201, { id: context.resourceId });
    },
  );
  await openDebug();
  click(button("Create welcome thread"));
  await received.promise;
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.organization({
      activeOrg: { id: "org_other", name: "Other workspace" },
      memberships: [{ id: "org_other" }],
    });
    clerk.stateChanged();
  });
  await aborted.promise;
  release.resolve();
  expect(window.location.pathname).not.toMatch(/^\/chats\//);
  expect(screen.queryByRole("alert")).toBeNull();
});
