import { ILLUSTRATION_TEMPLATE_ITEMS, VIDEO_TEMPLATE_ITEMS } from "@vm0/core";
import type {
  GenerationTemplateRequest,
  ThreadGenerationTemplates,
} from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { resolveThreadGenerationTemplatePrompt } from "../thread-generation-template";

type ResolveThreadGenerationTemplatePromptArgs = Parameters<
  typeof resolveThreadGenerationTemplatePrompt
>[0];

function mockDbForStoredGenerationTemplates(
  initial: ThreadGenerationTemplates,
): {
  readonly db: ResolveThreadGenerationTemplatePromptArgs["db"];
  readonly readStored: () => ThreadGenerationTemplates;
} {
  let stored = initial;
  const db = {
    select: () => {
      return {
        from: () => {
          return {
            where: () => {
              return {
                limit: () => {
                  return [{ generationTemplate: stored }];
                },
              };
            },
          };
        },
      };
    },
    update: () => {
      return {
        set: (values: { generationTemplate: ThreadGenerationTemplates }) => {
          stored = values.generationTemplate;
          return {
            where: () => {
              return undefined;
            },
          };
        },
      };
    },
  };

  return {
    db: db as unknown as ResolveThreadGenerationTemplatePromptArgs["db"],
    readStored: () => {
      return stored;
    },
  };
}

describe("resolveThreadGenerationTemplatePrompt", () => {
  it("replaces the matching sticky template slot when a new explicit template is selected", async () => {
    const previousIllustration = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.illustrationStyleId === "image-style:sunlit-gouache";
    });
    const nextIllustration = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.illustrationStyleId === "image-style:folk-storybook";
    });
    const videoTemplate = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.id === "video-template:epic-grandeur";
    });
    if (!previousIllustration || !nextIllustration || !videoTemplate) {
      throw new Error("Expected registered generation template fixtures");
    }

    const videoSelection: GenerationTemplateRequest = {
      type: "video",
      selection: { stylePresetId: videoTemplate.id },
    };
    const { db, readStored } = mockDbForStoredGenerationTemplates({
      illustration: {
        type: "illustration",
        selection: {
          illustrationStyleId: previousIllustration.illustrationStyleId,
        },
      },
      video: videoSelection,
    });

    const prompt = await resolveThreadGenerationTemplatePrompt({
      db,
      threadId: "thread-1",
      explicit: {
        type: "illustration",
        selection: {
          illustrationStyleId: nextIllustration.illustrationStyleId,
        },
      },
    });

    expect(prompt).toContain(nextIllustration.illustrationStyleId);
    expect(prompt).not.toContain(previousIllustration.illustrationStyleId);
    expect(prompt).toContain(videoTemplate.id);
    expect(readStored()).toStrictEqual({
      illustration: {
        type: "illustration",
        selection: {
          illustrationStyleId: nextIllustration.illustrationStyleId,
        },
      },
      video: videoSelection,
    });
  });
});
