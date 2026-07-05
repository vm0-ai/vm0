import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import type {
  TestChatThreadStateActionBody,
  TestChatThreadStateActionResponse,
  TestChatThreadStateFixture,
} from "@vm0/api-contracts/contracts/test-chat-thread-state";
import { command } from "ccstate";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testChatThreadStateRoutes } from "../../test-chat-thread-state";

const CHAT_THREAD_STATE_ROUTE = "/api/test/chat-thread-state";

export interface ZeroChatThreadFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly threadId: string;
}

interface SeedChatThreadOptions {
  readonly userId?: string;
  readonly orgId?: string;
  readonly title?: string | null;
  readonly pinnedAt?: Date | null;
  readonly renamedAt?: Date | null;
  readonly lastReadAt?: Date | null;
  readonly draftContent?: string | null;
  readonly draftAttachments?: readonly PersistedAttachment[] | null;
  readonly createdAt?: Date;
  readonly agentAvatarUrl?: string | null;
}

type ChatThreadRunStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "pending"
  | "queued"
  | "running";

interface SeedChatThreadRunOptions {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly status: ChatThreadRunStatus;
}

function dateToWire(value: Date | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return value.toISOString();
}

function fixtureFromWire(
  fixture: TestChatThreadStateFixture,
): ZeroChatThreadFixture {
  return {
    userId: fixture.user_id,
    orgId: fixture.org_id,
    composeId: fixture.compose_id,
    threadId: fixture.thread_id,
  };
}

function fixtureToWire(
  fixture: ZeroChatThreadFixture,
): TestChatThreadStateFixture {
  return {
    user_id: fixture.userId,
    org_id: fixture.orgId,
    compose_id: fixture.composeId,
    thread_id: fixture.threadId,
  };
}

function requestChatThreadState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testChatThreadStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestChatThreadStateActionBody,
): Promise<TestChatThreadStateActionResponse> {
  const response = await requestChatThreadState(
    signal,
    `${CHAT_THREAD_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expectOk(response, `chat thread state ${body.action}`);
  return await readJson<TestChatThreadStateActionResponse>(response);
}

export const seedZeroChatThread$ = command(
  async (
    _,
    options: SeedChatThreadOptions,
    signal: AbortSignal,
  ): Promise<ZeroChatThreadFixture> => {
    const response = await postAction(signal, {
      action: "seed-thread",
      user_id: options.userId,
      org_id: options.orgId,
      title: options.title,
      pinned_at: dateToWire(options.pinnedAt),
      renamed_at: dateToWire(options.renamedAt),
      last_read_at: dateToWire(options.lastReadAt),
      draft_content: options.draftContent,
      draft_attachments: options.draftAttachments
        ? [...options.draftAttachments]
        : options.draftAttachments,
      created_at: dateToWire(options.createdAt) ?? undefined,
      agent_avatar_url: options.agentAvatarUrl,
    });
    if (!response.fixture) {
      throw new Error("seedZeroChatThread$: response missing fixture");
    }
    return fixtureFromWire(response.fixture);
  },
);

export const deleteZeroChatThread$ = command(
  async (
    _,
    fixture: ZeroChatThreadFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "delete-thread",
      fixture: fixtureToWire(fixture),
    });
  },
);

export const seedZeroChatThreadRun$ = command(
  async (
    _,
    options: SeedChatThreadRunOptions,
    signal: AbortSignal,
  ): Promise<string> => {
    const response = await postAction(signal, {
      action: "seed-thread-run",
      user_id: options.userId,
      org_id: options.orgId,
      agent_id: options.agentId,
      thread_id: options.threadId,
      status: options.status,
    });
    if (!response.run_id) {
      throw new Error("seedZeroChatThreadRun$: response missing run id");
    }
    return response.run_id;
  },
);

export const updateZeroChatThreadRunStatus$ = command(
  async (
    _,
    args: {
      readonly runId: string;
      readonly status: ChatThreadRunStatus;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "update-thread-run-status",
      run_id: args.runId,
      status: args.status,
    });
  },
);
