/** Official HyperFrames authoring source used by vm0 video templates. */
export const HYPERFRAMES_AUTHORING_SOURCE = {
  repo: "heygen-com/hyperframes",
  ref: "6eaa2cb64b280c51cadb3843ce190f6f0b7493cc",
  entrySkillPath: "skills/hyperframes/SKILL.md",
  workflowSkillPaths: {
    productLaunchVideo: "skills/product-launch-video/SKILL.md",
    facelessExplainer: "skills/faceless-explainer/SKILL.md",
  },
  blueprintIndexPath: "skills/hyperframes-animation/blueprints-index.md",
  rulesIndexPath: "skills/hyperframes-animation/rules-index.md",
} as const;

/**
 * The published CLI is versioned independently from the Git authoring source.
 * Keep both pins explicit so a source update cannot silently change rendering.
 */
export const HYPERFRAMES_RUNTIME = {
  packageName: "hyperframes",
  version: "0.8.14",
  packageSpec: "hyperframes@0.8.14",
} as const;
