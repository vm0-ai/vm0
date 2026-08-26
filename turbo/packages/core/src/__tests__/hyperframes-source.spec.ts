import { describe, expect, it } from "vitest";

import {
  HYPERFRAMES_AUTHORING_SOURCE,
  HYPERFRAMES_RUNTIME,
} from "../hyperframes-source";

describe("HyperFrames source pins", () => {
  it("keeps the official authoring source and published runtime explicit", () => {
    expect(HYPERFRAMES_AUTHORING_SOURCE).toEqual({
      repo: "heygen-com/hyperframes",
      ref: "6eaa2cb64b280c51cadb3843ce190f6f0b7493cc",
      entrySkillPath: "skills/hyperframes/SKILL.md",
      workflowSkillPaths: {
        productLaunchVideo: "skills/product-launch-video/SKILL.md",
        facelessExplainer: "skills/faceless-explainer/SKILL.md",
      },
      blueprintIndexPath: "skills/hyperframes-animation/blueprints-index.md",
      rulesIndexPath: "skills/hyperframes-animation/rules-index.md",
    });
    expect(HYPERFRAMES_AUTHORING_SOURCE.ref).toMatch(/^[0-9a-f]{40}$/u);
    expect(HYPERFRAMES_RUNTIME).toEqual({
      packageName: "hyperframes",
      version: "0.8.14",
      packageSpec: "hyperframes@0.8.14",
    });
  });
});
