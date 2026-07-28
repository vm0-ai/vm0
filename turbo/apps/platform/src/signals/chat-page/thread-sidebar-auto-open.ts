import type { GroupedChatMessageGroup } from "./chat-message.ts";
import type { BodyRenderBlock } from "./parse-body-blocks.ts";

export type ThreadSidebarAutoOpenCandidate =
  | { readonly type: "artifact"; readonly resourceKey: string }
  | { readonly type: "email-draft"; readonly resourceKey: string }
  | { readonly type: "browser"; readonly resourceKey: string };

type RunGroupState = "running" | "completed" | null;

function runGroupState(group: GroupedChatMessageGroup): RunGroupState {
  if (group.role !== "assistant") {
    return null;
  }

  let hasRun = false;
  let completed = false;
  for (const message of group.messages) {
    hasRun ||= message.runId !== undefined;
    if (
      message.eventType === "run.failed" ||
      message.eventType === "run.cancelled"
    ) {
      return null;
    }
    if (message.eventType === "run.completed") {
      completed = true;
    }
  }

  if (!hasRun) {
    return null;
  }
  return completed ? "completed" : "running";
}

function autoOpenCandidateFromBlock(
  block: BodyRenderBlock,
): ThreadSidebarAutoOpenCandidate | null {
  switch (block.type) {
    case "artifact": {
      return { type: "artifact", resourceKey: block.signals.url };
    }
    case "mail-draft": {
      return {
        type: "email-draft",
        resourceKey: block.signals.mailDraftId,
      };
    }
    case "browser-session": {
      return { type: "browser", resourceKey: block.signals.browserId };
    }
    case "markdown":
    case "connector-action":
    case "custom-connector-action":
    case "permission-action":
    case "computer-use-authorization":
    case "plan-upgrade": {
      return null;
    }
  }
}

function latestAutoOpenCandidateInGroup(
  group: GroupedChatMessageGroup,
): ThreadSidebarAutoOpenCandidate | null {
  for (
    let messageIndex = group.messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = group.messages[messageIndex];
    if (!message) {
      continue;
    }
    for (
      let blockIndex = message.blocks.length - 1;
      blockIndex >= 0;
      blockIndex--
    ) {
      const block = message.blocks[blockIndex];
      if (!block) {
        continue;
      }
      const candidate = autoOpenCandidateFromBlock(block);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Prefer the newest sidebar-capable card in any running run. If no running
 * run has one, fall back to the newest successfully completed run that does.
 */
export function latestThreadSidebarAutoOpenCandidate(
  groups: readonly GroupedChatMessageGroup[],
): ThreadSidebarAutoOpenCandidate | null {
  let latestCompletedCandidate: ThreadSidebarAutoOpenCandidate | null = null;

  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
    const group = groups[groupIndex];
    if (!group) {
      continue;
    }
    const state = runGroupState(group);
    if (!state) {
      continue;
    }
    const candidate = latestAutoOpenCandidateInGroup(group);
    if (!candidate) {
      continue;
    }
    if (state === "running") {
      return candidate;
    }
    latestCompletedCandidate ??= candidate;
  }

  return latestCompletedCandidate;
}

export function threadSidebarAutoOpenCandidateKey(
  candidate: ThreadSidebarAutoOpenCandidate,
): string {
  return `${candidate.type}:${candidate.resourceKey}`;
}
