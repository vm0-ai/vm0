import { computed, type Computed } from "ccstate";

import { settle } from "../utils.ts";
import type { ChatEventGroup } from "./chat-event.ts";
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
    };

function runGroupState(group: ChatEventGroup): RunGroupState {
  if (group.role !== "assistant") {
    return null;
  }

  let hasRun = false;
  let completed = false;
  for (const event of group.events) {
    hasRun ||= event.runId !== undefined;
    if (
      event.eventType === "run.failed" ||
      event.eventType === "run.cancelled"
    ) {
      return null;
    }
    if (event.eventType === "run.completed") {
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
  group: ChatEventGroup,
): ThreadSidebarAutoOpenCandidateSource[] {
  const candidates: ThreadSidebarAutoOpenCandidateSource[] = [];
  for (
    let eventIndex = group.events.length - 1;
    eventIndex >= 0;
    eventIndex--
  ) {
    const event = group.events[eventIndex];
    if (!event) {
      continue;
    }
    for (
      let blockIndex = event.blocks.length - 1;
      blockIndex >= 0;
      blockIndex--
    ) {
      const block = event.blocks[blockIndex];
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
  groups: readonly ChatEventGroup[],
): ThreadSidebarAutoOpenCandidateSource[] {
  const running: ThreadSidebarAutoOpenCandidateSource[] = [];
  let latestCompleted: ThreadSidebarAutoOpenCandidateSource[] | undefined;
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
    const group = groups[groupIndex];
    if (!group) {
      continue;
    }
    const state = runGroupState(group);
    if (!state) {
      continue;
    }
    if (state === "running") {
      running.push(...autoOpenCandidatesInGroup(group));
      continue;
    }
    if (latestCompleted === undefined) {
      // An empty newest completed group intentionally blocks fallback to
      // cards from older completed runs.
      latestCompleted = autoOpenCandidatesInGroup(group);
    }
  }
  return [...running, ...(latestCompleted ?? [])];
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
  allRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
): Computed<Promise<ThreadSidebarAutoOpenCandidate | null>> {
  return computed(async (get) => {
    const sources = orderedThreadSidebarAutoOpenCandidates(
      await get(allRenderedChatGroups$),
    );
    for (const source of sources) {
      if (source.type === "artifact" || source.type === "browser") {
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
    }
    return null;
  });
}

export function threadSidebarAutoOpenCandidateKey(
  candidate: ThreadSidebarAutoOpenCandidate,
): string {
  return `${candidate.type}:${candidate.resourceKey}`;
}
