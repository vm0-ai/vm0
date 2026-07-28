import { computed, type Computed } from "ccstate";

import { settle } from "../utils.ts";
import type { GroupedChatMessageGroup } from "./chat-message.ts";
import type { BodyRenderBlock } from "./parse-body-blocks.ts";

export type ThreadSidebarAutoOpenCandidate =
  | { readonly type: "artifact"; readonly resourceKey: string }
  | { readonly type: "email-draft"; readonly resourceKey: string }
  | { readonly type: "browser"; readonly resourceKey: string };

type RunGroupState = "running" | "completed" | null;

type ThreadSidebarAutoOpenCandidateSource =
  | {
      readonly type: "artifact";
      readonly resourceKey: string;
    }
  | {
      readonly type: "email-draft";
      readonly resourceKey: string;
      readonly signals: Extract<
        BodyRenderBlock,
        { type: "mail-draft" }
      >["signals"];
    }
  | {
      readonly type: "browser";
      readonly resourceKey: string;
      readonly signals: Extract<
        BodyRenderBlock,
        { type: "browser-session" }
      >["signals"];
    };

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
): ThreadSidebarAutoOpenCandidateSource | null {
  switch (block.type) {
    case "artifact": {
      return { type: "artifact", resourceKey: block.signals.url };
    }
    case "mail-draft": {
      return {
        type: "email-draft",
        resourceKey: block.signals.mailDraftId,
        signals: block.signals,
      };
    }
    case "browser-session": {
      return {
        type: "browser",
        resourceKey: block.signals.browserId,
        signals: block.signals,
      };
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

function autoOpenCandidatesInGroup(
  group: GroupedChatMessageGroup,
): ThreadSidebarAutoOpenCandidateSource[] {
  const candidates: ThreadSidebarAutoOpenCandidateSource[] = [];
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
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function orderedThreadSidebarAutoOpenCandidates(
  groups: readonly GroupedChatMessageGroup[],
): ThreadSidebarAutoOpenCandidateSource[] {
  const running: ThreadSidebarAutoOpenCandidateSource[] = [];
  const completed: ThreadSidebarAutoOpenCandidateSource[] = [];
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
    const group = groups[groupIndex];
    if (!group) {
      continue;
    }
    const state = runGroupState(group);
    if (!state) {
      continue;
    }
    const target = state === "running" ? running : completed;
    target.push(...autoOpenCandidatesInGroup(group));
  }
  return [...running, ...completed];
}

function candidateFromSource(
  source: ThreadSidebarAutoOpenCandidateSource,
): ThreadSidebarAutoOpenCandidate {
  return { type: source.type, resourceKey: source.resourceKey };
}

/**
 * Prefer the newest openable card in any running run. If no running run has
 * one, fall back to the newest openable card in a successfully completed run.
 */
export function createThreadSidebarAutoOpenCandidate(
  allRenderedChatGroups$: Computed<Promise<GroupedChatMessageGroup[]>>,
): Computed<Promise<ThreadSidebarAutoOpenCandidate | null>> {
  return computed(async (get) => {
    const sources = orderedThreadSidebarAutoOpenCandidates(
      await get(allRenderedChatGroups$),
    );
    for (const source of sources) {
      if (source.type === "artifact") {
        return candidateFromSource(source);
      }
      if (source.type === "email-draft") {
        const draft = await settle(get(source.signals.draft$));
        if (
          draft.ok &&
          draft.value !== null &&
          draft.value.status !== "deleted" &&
          draft.value.accessStatus !== "reconnect"
        ) {
          return candidateFromSource(source);
        }
        continue;
      }
      const session = await settle(get(source.signals.session$));
      if (session.ok && session.value !== null) {
        return candidateFromSource(source);
      }
    }
    return null;
  });
}

export function threadSidebarAutoOpenCandidateKey(
  candidate: ThreadSidebarAutoOpenCandidate,
): string {
  return `${candidate.type}:${candidate.resourceKey}`;
}
