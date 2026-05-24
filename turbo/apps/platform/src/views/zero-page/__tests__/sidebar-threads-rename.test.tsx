import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
  chatThreadRenameContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

type ThreadFixture = {
  id: string;
  title: string | null;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  isRead: boolean;
  running: boolean;
};

function makeThread(
  id: string,
  title: string | null,
  createdAt: string,
  pinnedAt: string | null = null,
): ThreadFixture {
  return {
    id,
    title,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt,
    updatedAt: createdAt,
    pinnedAt,
    isRead: true,
    running: false,
  };
}

function setupMocks(initial: ThreadFixture[]) {
  let threads = [...initial];
  let lastRenamed: { id: string; title: string } | null = null;
  let lastDeleted: string | null = null;

  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads });
    }),
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      const thread = threads.find((t) => {
        return t.id === params.id;
      });
      return respond(200, {
        id: params.id,
        title: thread?.title ?? null,
        agentId: AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(chatThreadByIdContract.delete, ({ params, respond }) => {
      lastDeleted = params.id;
      threads = threads.filter((t) => {
        return t.id !== params.id;
      });
      return respond(204);
    }),
    mockApi(chatThreadPinContract.pin, ({ respond }) => {
      return respond(204);
    }),
    mockApi(chatThreadUnpinContract.unpin, ({ respond }) => {
      return respond(204);
    }),
    mockApi(chatThreadRenameContract.rename, ({ params, body, respond }) => {
      lastRenamed = { id: params.id, title: body.title };
      threads = threads.map((t) => {
        return t.id === params.id ? { ...t, title: body.title } : t;
      });
      return respond(204);
    }),
  );

  return {
    getLastRenamed: () => {
      return lastRenamed;
    },
    getLastDeleted: () => {
      return lastDeleted;
    },
  };
}

describe("sidebar chat thread rename", () => {
  it("flag ON: kebab menu adds Rename chat alongside Pin and Delete", async () => {
    setupMocks([
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
      makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-1",
      featureSwitches: {
        [FeatureSwitchKey.ChatThreadRename]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const triggers = screen.getAllByTestId("chat-thread-menu-trigger");
    expect(triggers).toHaveLength(2);

    click(triggers[0]);

    const menu = await waitFor(() => {
      return screen.getByRole("menu");
    });
    expect(within(menu).getByText("Rename chat")).toBeInTheDocument();
    expect(within(menu).getByText("Delete chat")).toBeInTheDocument();
    expect(within(menu).getByText("Pin chat")).toBeInTheDocument();
  });

  it("flag OFF: kebab menu omits Rename chat", async () => {
    setupMocks([
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
      makeThread("thread-2", "Second chat", "2026-03-09T00:00:00Z"),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-1",
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const triggers = screen.getAllByTestId("chat-thread-menu-trigger");
    click(triggers[0]);

    const menu = await waitFor(() => {
      return screen.getByRole("menu");
    });
    expect(within(menu).getByText("Pin chat")).toBeInTheDocument();
    expect(within(menu).getByText("Delete chat")).toBeInTheDocument();
    expect(within(menu).queryByText("Rename chat")).not.toBeInTheDocument();
  });

  it("flag ON: rename dialog opens, submits new title, closes dialog", async () => {
    const { getLastRenamed } = setupMocks([
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-1",
      featureSwitches: {
        [FeatureSwitchKey.ChatThreadRename]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const triggers = screen.getAllByTestId("chat-thread-menu-trigger");
    click(triggers[0]);

    const menu = await waitFor(() => {
      return screen.getByRole("menu");
    });
    click(within(menu).getByText("Rename chat"));

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    expect(within(dialog).getByText("Rename chat")).toBeInTheDocument();

    const input = within(dialog).getByPlaceholderText("Chat title");
    // Simulate changing the input value
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeInputValueSetter?.call(input, "Renamed chat");
    input.dispatchEvent(new Event("input", { bubbles: true }));

    click(within(dialog).getByText("Rename"));

    await waitFor(() => {
      expect(getLastRenamed()).toStrictEqual({
        id: "thread-1",
        title: "Renamed chat",
      });
    });
  });

  it("flag ON: Cancel button closes dialog without renaming", async () => {
    const { getLastRenamed } = setupMocks([
      makeThread("thread-1", "First chat", "2026-03-10T00:00:00Z"),
    ]);

    detachedSetupPage({
      context,
      path: "/chats/thread-1",
      featureSwitches: {
        [FeatureSwitchKey.ChatThreadRename]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("First chat")).toBeInTheDocument();
    });

    const triggers = screen.getAllByTestId("chat-thread-menu-trigger");
    click(triggers[0]);

    const menu = await waitFor(() => {
      return screen.getByRole("menu");
    });
    click(within(menu).getByText("Rename chat"));

    const dialog = await waitFor(() => {
      return screen.getByRole("dialog");
    });
    click(within(dialog).getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    expect(getLastRenamed()).toBeNull();
  });
});
