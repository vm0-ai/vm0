import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@okouai/api-contracts/contracts/chat-threads";
import { computed, createStore } from "ccstate";
import {
  markdownCardKey,
  parseMarkdownTree,
} from "../../../lib/markdown/pipeline.ts";
import { describe, expect, it } from "vitest";
import { createArtifactCardSignalsRegistry } from "../../../signals/chat-page/artifact-card-signals.ts";
import { createAttachmentResourceUrlResolver } from "../../../signals/attachment-resource-url.ts";
import type { MarkdownCardRef } from "../../../signals/chat-page/markdown-card-ref.ts";
import {
  cardSlotUrl,
  eventBodyPlan,
} from "../../../signals/chat-page/parse-body-blocks.ts";
import { currentEventImageArtifactNavigation } from "../artifact-image-navigation.ts";

type EventFixture = Parameters<
  typeof currentEventImageArtifactNavigation
>[1][number]["events"][number];

const emptyArtifactPreviewImageUrls$ = computed(() => {
  return Promise.resolve(new Map<string, string>());
});

function artifactFile(
  url: string,
  overrides: Partial<ChatThreadArtifactFile> = {},
): ChatThreadArtifactFile {
  return {
    id: "artifact-image",
    filename: "image.png",
    contentType: "image/png",
    size: 1024,
    url,
    createdAt: "2026-03-10T00:00:01Z",
    googleDriveSync: { status: "not_synced" },
    ...overrides,
  };
}

const store = createStore();

function assistantEvent({ content }: { content: string }): EventFixture {
  const artifactCardSignals = createArtifactCardSignalsRegistry(
    emptyArtifactPreviewImageUrls$,
    createAttachmentResourceUrlResolver(),
  );
  const plan = eventBodyPlan(content, { previews: true });
  const cards = new Map<string, MarkdownCardRef>();
  for (const descriptor of plan.descriptors) {
    if (descriptor.type !== "artifact") {
      throw new Error(`Unexpected body card: ${descriptor.type}`);
    }
    cards.set(markdownCardKey(cardSlotUrl(descriptor)), {
      kind: "artifact",
      signals: store.set(artifactCardSignals.register$, descriptor.descriptor),
      threadId: "test-thread",
    });
  }
  return {
    tree: parseMarkdownTree(plan.treeSource, {
      mermaid: true,
      cards,
    }),
  };
}

describe("currentEventImageArtifactNavigation", () => {
  it("navigates assistant images split across events in the same group", () => {
    const firstImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/first.png";
    const secondImageUrl =
      "https://cdn.vm7.io/artifacts/test/body-image-split-navigation/second.png";
    const runId = "run-body-image-split-navigation";
    const runs: ChatThreadArtifactRun[] = [
      {
        runId,
        files: [
          artifactFile(firstImageUrl, {
            id: "artifact-body-split-first-image",
            filename: "first.png",
          }),
          artifactFile(secondImageUrl, {
            id: "artifact-body-split-second-image",
            filename: "second.png",
          }),
        ],
      },
    ];
    const groups: Parameters<typeof currentEventImageArtifactNavigation>[1] = [
      {
        role: "assistant",
        events: [
          assistantEvent({ content: "Generated images:" }),
          assistantEvent({
            content: `1. ![first.png](${firstImageUrl})`,
          }),
          assistantEvent({
            content: `2. ![second.png](${secondImageUrl})`,
          }),
        ],
      },
    ];

    const navigation = currentEventImageArtifactNavigation(
      runs,
      groups,
      firstImageUrl,
    );

    expect(navigation.previous).toBeUndefined();
    expect(navigation.next).toMatchObject({
      url: secondImageUrl,
      filename: "second.png",
    });
  });
});
