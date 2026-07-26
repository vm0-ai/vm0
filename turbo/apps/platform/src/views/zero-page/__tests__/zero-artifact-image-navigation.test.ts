import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import { computed } from "ccstate";
import { describe, expect, it } from "vitest";
import { createArtifactCardSignalsRegistry } from "../../../signals/chat-page/artifact-card-signals.ts";
import {
  parseBodyBlocks,
  type BodyRenderBlock,
  type ParsedBodyBlock,
} from "../../../signals/chat-page/parse-body-blocks.ts";
import { currentMessageImageArtifactNavigation } from "../zero-artifact-image-navigation.ts";

type MessageFixture = Parameters<
  typeof currentMessageImageArtifactNavigation
>[1][number]["messages"][number];

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

function assistantMessage({ content }: { content: string }): MessageFixture {
  const artifactCardSignals = createArtifactCardSignalsRegistry(
    emptyArtifactPreviewImageUrls$,
  );
  const renderBlock = (block: ParsedBodyBlock): BodyRenderBlock => {
    if (block.type === "markdown") {
      return block;
    }
    if (block.type === "artifact") {
      return {
        type: block.type,
        resourceKey: block.resourceKey,
        signals: artifactCardSignals.register(block.descriptor),
      };
    }
    throw new Error(`Unexpected body block: ${block.type}`);
  };
  return {
    blocks: parseBodyBlocks(content, { previews: true }).blocks.map(
      renderBlock,
    ),
  };
}

describe("currentMessageImageArtifactNavigation", () => {
  it("navigates assistant images split across messages in the same group", () => {
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
    const groups = [
      {
        messages: [
          assistantMessage({ content: "Generated images:" }),
          assistantMessage({
            content: `1. ![first.png](${firstImageUrl})`,
          }),
          assistantMessage({
            content: `2. ![second.png](${secondImageUrl})`,
          }),
        ],
      },
    ];

    const navigation = currentMessageImageArtifactNavigation(
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
