import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";
import { parseBodyRenderBlocks } from "../../../signals/chat-page/parse-body-blocks.ts";
import { currentMessageImageArtifactNavigation } from "../zero-artifact-image-navigation.ts";

type MessageFixture = Parameters<
  typeof currentMessageImageArtifactNavigation
>[1][number]["messages"][number];

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
  return {
    blocks: parseBodyRenderBlocks(content, { previews: true }).blocks,
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
