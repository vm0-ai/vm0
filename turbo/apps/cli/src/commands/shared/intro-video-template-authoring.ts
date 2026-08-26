import {
  HYPERFRAMES_AUTHORING_SOURCE,
  HYPERFRAMES_RUNTIME,
} from "@okouai/core/hyperframes-source";
import type { IntroVideoTemplateItem } from "@okouai/core/intro-video-template-items";

interface IntroVideoTemplateAuthoringOptions {
  readonly prompt: string;
  readonly template: IntroVideoTemplateItem;
}

interface IntroVideoTemplateAuthoringPacket {
  readonly type: "intro-video-authoring";
  readonly prompt: string;
  readonly implementation: {
    readonly type: "hyperframes";
    readonly source: typeof HYPERFRAMES_AUTHORING_SOURCE;
    readonly runtime: typeof HYPERFRAMES_RUNTIME;
  };
  readonly template: IntroVideoTemplateItem;
  readonly instructions: string;
}

export function createIntroVideoTemplateAuthoringPacket(
  options: IntroVideoTemplateAuthoringOptions,
): IntroVideoTemplateAuthoringPacket {
  const sourceDir = "./generated/resources/hyperframes";
  const projectDir = `./generated/videos/${options.template.slug}`;
  const workflowSkillPath =
    HYPERFRAMES_AUTHORING_SOURCE.workflowSkillPaths[
      options.template.implementation.workflow === "faceless-explainer"
        ? "facelessExplainer"
        : "productLaunchVideo"
    ];
  const storyBeats = options.template.story.beats.map((beat) => {
    return `- ${beat}`;
  });
  const blueprintIds = options.template.implementation.motion.blueprintIds.map(
    (id) => {
      return `- ${id}`;
    },
  );
  const ruleIds = options.template.implementation.motion.ruleIds.map((id) => {
    return `- ${id}`;
  });
  const instructions = [
    `# Okou generate intro-video --template ${options.template.id}`,
    "",
    "This is the locked HyperFrames authoring packet for the current agent. Okou is not rendering the video on the server in this scaffold.",
    "",
    "## User Prompt",
    options.prompt,
    "",
    "## Selected Template Recipe",
    `- Template: ${options.template.title} (${options.template.id})`,
    `- Description: ${options.template.description}`,
    `- Implementation: ${options.template.implementation.label}`,
    `- Official workflow: ${options.template.implementation.workflow}`,
    `- Story pattern: ${options.template.story.pattern}`,
    `- Framing rule: ${options.template.framingRule}`,
    "",
    "Story beats:",
    ...storyBeats,
    "",
    "Preferred HyperFrames blueprints:",
    ...blueprintIds,
    "",
    "Preferred HyperFrames motion rules:",
    ...ruleIds,
    "",
    "## Fixed Source and Runtime",
    `- Repository: ${HYPERFRAMES_AUTHORING_SOURCE.repo}`,
    `- Commit: ${HYPERFRAMES_AUTHORING_SOURCE.ref}`,
    `- Runtime: ${HYPERFRAMES_RUNTIME.packageSpec}`,
    "- The Git authoring source and published runtime are separate pins. Keep both exact.",
    "",
    "Fetch the official source at the pinned commit:",
    "```bash",
    `git init ${sourceDir}`,
    `git -C ${sourceDir} remote add origin https://github.com/${HYPERFRAMES_AUTHORING_SOURCE.repo}.git`,
    `git -C ${sourceDir} fetch --depth 1 origin ${HYPERFRAMES_AUTHORING_SOURCE.ref}`,
    `git -C ${sourceDir} checkout --detach FETCH_HEAD`,
    `test "$(git -C ${sourceDir} rev-parse HEAD)" = "${HYPERFRAMES_AUTHORING_SOURCE.ref}"`,
    "```",
    "",
    "Read these checked-out files completely before authoring:",
    `- ${sourceDir}/${HYPERFRAMES_AUTHORING_SOURCE.entrySkillPath}`,
    `- ${sourceDir}/${workflowSkillPath}`,
    `- ${sourceDir}/${HYPERFRAMES_AUTHORING_SOURCE.blueprintIndexPath}`,
    `- ${sourceDir}/${HYPERFRAMES_AUTHORING_SOURCE.rulesIndexPath}`,
    "",
    "Pinning override:",
    `- Use only \`npx --yes ${HYPERFRAMES_RUNTIME.packageSpec}\` for HyperFrames CLI commands.`,
    "- Do not run `hyperframes skills update`, `hyperframes@latest`, or `hyperframes upgrade`; vm0 owns source and runtime upgrades.",
    "- Prefix init with `HYPERFRAMES_SKIP_SKILLS=1` so the pinned checkout is not replaced by global latest skills.",
    "",
    "## Authoring Flow",
    `1. Scaffold with \`HYPERFRAMES_SKIP_SKILLS=1 npx --yes ${HYPERFRAMES_RUNTIME.packageSpec} init ${projectDir} --non-interactive --example=blank --skill=${options.template.implementation.workflow}\`.`,
    "2. Follow the checked-out workflow using the user's content and brand. Do not ask the user to choose story structure or motion again; this template recipe already supplies the defaults.",
    "3. Use the story beats as the narrative spine. Do not invent evidence that the source material does not support.",
    "4. Use the listed blueprints and rules as the preferred motion vocabulary when they fit the beat; do not force every reference into the cut.",
    `5. Apply the framing rule exactly: ${options.template.framingRule}`,
    "6. Do not use opacity fading as an element's primary entrance. Prefer hard cuts, transform-led arrivals, masks, or the selected spring entrance rule.",
    `7. Check and render with the pinned runtime, keeping project files under \`${projectDir}\` and the final video at \`${projectDir}/renders/video.mp4\`.`,
    "",
    "## Deliverable",
    `- Final video: ${projectDir}/renders/video.mp4`,
    `- Storyboard: ${projectDir}/STORYBOARD.md`,
    `- Source composition: ${projectDir}/compositions/`,
    "- Return the final video URL or delivered file plus the template id.",
  ].join("\n");

  return {
    type: "intro-video-authoring",
    prompt: options.prompt,
    implementation: {
      type: "hyperframes",
      source: HYPERFRAMES_AUTHORING_SOURCE,
      runtime: HYPERFRAMES_RUNTIME,
    },
    template: options.template,
    instructions,
  };
}
