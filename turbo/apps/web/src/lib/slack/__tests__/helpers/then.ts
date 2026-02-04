/**
 * BDD "Then" Helpers - Assertion helpers for Slack tests
 *
 * These helpers verify expected outcomes.
 * They follow the "Then" step pattern in BDD tests.
 */
import { expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../lib/init-services";
import { slackUserLinks } from "../../../../db/schema/slack-user-link";
import { slackBindings } from "../../../../db/schema/slack-binding";
import { slackThreadSessions } from "../../../../db/schema/slack-thread-session";
import type { MockSlackClient, SlackApiCall } from "./mocks";

/**
 * Then Slack should have received a message.
 * Verifies chat.postMessage was called with expected content.
 */
export function thenSlackShouldReceiveMessage(
  mockClient: MockSlackClient,
  matcher: {
    channel?: string;
    text?: string | RegExp;
    threadTs?: string;
    hasBlocks?: boolean;
  },
): void {
  const calls = mockClient.getCalls("chat.postMessage");
  expect(calls.length).toBeGreaterThan(0);

  const matchingCall = calls.find((call) => {
    const args = call.args as {
      channel?: string;
      text?: string;
      thread_ts?: string;
      blocks?: unknown[];
    };

    if (matcher.channel && args.channel !== matcher.channel) return false;
    if (matcher.text) {
      if (typeof matcher.text === "string") {
        if (!args.text?.includes(matcher.text)) return false;
      } else {
        if (!matcher.text.test(args.text ?? "")) return false;
      }
    }
    if (matcher.threadTs && args.thread_ts !== matcher.threadTs) return false;
    if (
      matcher.hasBlocks !== undefined &&
      (args.blocks !== undefined) !== matcher.hasBlocks
    )
      return false;

    return true;
  });

  expect(
    matchingCall,
    `Expected Slack to receive message matching ${JSON.stringify(matcher)}, but no matching call found. Calls: ${JSON.stringify(calls.map((c) => c.args))}`,
  ).toBeDefined();
}

/**
 * Then Slack should have updated a message.
 * Verifies chat.update was called.
 */
export function thenSlackShouldUpdateMessage(
  mockClient: MockSlackClient,
  matcher: {
    channel?: string;
    ts?: string;
    text?: string | RegExp;
  },
): void {
  const calls = mockClient.getCalls("chat.update");
  expect(calls.length).toBeGreaterThan(0);

  const matchingCall = calls.find((call) => {
    const args = call.args as {
      channel?: string;
      ts?: string;
      text?: string;
    };

    if (matcher.channel && args.channel !== matcher.channel) return false;
    if (matcher.ts && args.ts !== matcher.ts) return false;
    if (matcher.text) {
      if (typeof matcher.text === "string") {
        if (!args.text?.includes(matcher.text)) return false;
      } else {
        if (!matcher.text.test(args.text ?? "")) return false;
      }
    }

    return true;
  });

  expect(
    matchingCall,
    `Expected Slack message update matching ${JSON.stringify(matcher)}`,
  ).toBeDefined();
}

/**
 * Then a thinking reaction should have been added.
 * Verifies reactions.add was called with hourglass_flowing_sand.
 */
export function thenReactionShouldBeAdded(
  mockClient: MockSlackClient,
  emoji: string = "hourglass_flowing_sand",
): void {
  const calls = mockClient.getCalls("reactions.add");
  const matchingCall = calls.find((call) => {
    const args = call.args as { name?: string };
    return args.name === emoji;
  });

  expect(
    matchingCall,
    `Expected reaction "${emoji}" to be added`,
  ).toBeDefined();
}

/**
 * Then a thinking reaction should have been removed.
 * Verifies reactions.remove was called.
 */
export function thenReactionShouldBeRemoved(
  mockClient: MockSlackClient,
  emoji: string = "hourglass_flowing_sand",
): void {
  const calls = mockClient.getCalls("reactions.remove");
  const matchingCall = calls.find((call) => {
    const args = call.args as { name?: string };
    return args.name === emoji;
  });

  expect(
    matchingCall,
    `Expected reaction "${emoji}" to be removed`,
  ).toBeDefined();
}

/**
 * Then a thread session should exist in the database.
 * Verifies the thread → session mapping was created.
 */
export async function thenThreadSessionShouldExist(
  bindingId: string,
  channelId: string,
  threadTs: string,
): Promise<{ agentSessionId: string }> {
  initServices();

  const [session] = await globalThis.services.db
    .select()
    .from(slackThreadSessions)
    .where(
      and(
        eq(slackThreadSessions.slackBindingId, bindingId),
        eq(slackThreadSessions.slackChannelId, channelId),
        eq(slackThreadSessions.slackThreadTs, threadTs),
      ),
    )
    .limit(1);

  expect(
    session,
    `Expected thread session to exist for binding ${bindingId}, channel ${channelId}, thread ${threadTs}`,
  ).toBeDefined();

  return { agentSessionId: session!.agentSessionId };
}

/**
 * Then a thread session should NOT exist in the database.
 */
export async function thenThreadSessionShouldNotExist(
  bindingId: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  initServices();

  const [session] = await globalThis.services.db
    .select()
    .from(slackThreadSessions)
    .where(
      and(
        eq(slackThreadSessions.slackBindingId, bindingId),
        eq(slackThreadSessions.slackChannelId, channelId),
        eq(slackThreadSessions.slackThreadTs, threadTs),
      ),
    )
    .limit(1);

  expect(
    session,
    `Expected thread session NOT to exist for binding ${bindingId}`,
  ).toBeUndefined();
}

/**
 * Then a binding should exist for the user.
 */
export async function thenBindingShouldExist(
  userLinkId: string,
  agentName: string,
): Promise<{ id: string }> {
  initServices();

  const [binding] = await globalThis.services.db
    .select()
    .from(slackBindings)
    .where(
      and(
        eq(slackBindings.slackUserLinkId, userLinkId),
        eq(slackBindings.agentName, agentName),
      ),
    )
    .limit(1);

  expect(
    binding,
    `Expected binding "${agentName}" to exist for user link ${userLinkId}`,
  ).toBeDefined();

  return { id: binding!.id };
}

/**
 * Then a user link should exist.
 */
export async function thenUserLinkShouldExist(
  slackUserId: string,
  workspaceId: string,
): Promise<{ id: string; vm0UserId: string }> {
  initServices();

  const [link] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  expect(
    link,
    `Expected user link to exist for ${slackUserId} in ${workspaceId}`,
  ).toBeDefined();

  return { id: link!.id, vm0UserId: link!.vm0UserId };
}

/**
 * Then a user link should NOT exist.
 */
export async function thenUserLinkShouldNotExist(
  slackUserId: string,
  workspaceId: string,
): Promise<void> {
  initServices();

  const [link] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  expect(
    link,
    `Expected user link NOT to exist for ${slackUserId}`,
  ).toBeUndefined();
}

/**
 * Then orphaned bindings should exist (bindings without user link).
 */
export async function thenOrphanedBindingsShouldExist(
  vm0UserId: string,
  workspaceId: string,
  expectedCount: number,
): Promise<Array<{ id: string; agentName: string }>> {
  initServices();

  const bindings = await globalThis.services.db
    .select()
    .from(slackBindings)
    .where(
      and(
        eq(slackBindings.vm0UserId, vm0UserId),
        eq(slackBindings.slackWorkspaceId, workspaceId),
      ),
    );

  // Filter to only orphaned (no user link)
  const orphaned = bindings.filter((b) => b.slackUserLinkId === null);

  expect(
    orphaned.length,
    `Expected ${expectedCount} orphaned bindings, found ${orphaned.length}`,
  ).toBe(expectedCount);

  return orphaned.map((b) => ({ id: b.id, agentName: b.agentName }));
}

/**
 * Then bindings should be restored (linked to user).
 */
export async function thenBindingsShouldBeRestored(
  userLinkId: string,
  expectedCount: number,
): Promise<Array<{ id: string; agentName: string }>> {
  initServices();

  const bindings = await globalThis.services.db
    .select()
    .from(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLinkId));

  expect(
    bindings.length,
    `Expected ${expectedCount} restored bindings, found ${bindings.length}`,
  ).toBe(expectedCount);

  return bindings.map((b) => ({ id: b.id, agentName: b.agentName }));
}

/**
 * Then Slack should NOT have received any messages.
 */
export function thenSlackShouldNotReceiveMessage(
  mockClient: MockSlackClient,
): void {
  const calls = mockClient.getCalls("chat.postMessage");
  expect(
    calls.length,
    `Expected no messages, but found ${calls.length} calls`,
  ).toBe(0);
}

/**
 * Then Slack should have received exactly N messages.
 */
export function thenSlackShouldReceiveNMessages(
  mockClient: MockSlackClient,
  count: number,
): void {
  const calls = mockClient.getCalls("chat.postMessage");
  expect(
    calls.length,
    `Expected ${count} messages, but found ${calls.length}`,
  ).toBe(count);
}

/**
 * Get all Slack API calls for custom assertions.
 */
export function getSlackCalls(
  mockClient: MockSlackClient,
  method?: string,
): SlackApiCall[] {
  if (method) {
    return mockClient.getCalls(method);
  }
  return mockClient.calls;
}
