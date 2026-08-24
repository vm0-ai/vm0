/**
 * Where the deck-reverse-engineering guide lives.
 *
 * Not in `vm0-ai/vm0-skills`, and so not mounted by the skills sync, because
 * the guide is still being revised against real decks and its scripts change
 * with each run. Pointing at the working branch keeps that iteration out of
 * the every-minute sync and out of every unrelated run's skill mounts.
 *
 * The consequence is that this only resolves for a run whose GitHub access
 * covers a vm0 private repository, which is why every use of it is behind the
 * `PresentationTemplates` switch. Moving the guide into `vm0-skills` later
 * turns this constant into a plain skill name and removes the clone step;
 * that move is tracked in vm0-ai/vm0#28374, which is what stops this branch
 * pin from outliving the switch.
 */
const PRESENTATION_TEMPLATE_SKILL_REPO = "vm0-ai/Template-artifact";
const PRESENTATION_TEMPLATE_SKILL_BRANCH = "feat/reverse-template-skill";
const PRESENTATION_TEMPLATE_SKILL_PATH = "reverse-template";

/**
 * Tell a run how to reach the guide.
 *
 * A few sentences, used both by the import message the template picker sends
 * and by the standing agent-tools prompt, so a deck dropped in the chat box
 * reaches the same instructions as one picked through the dialog.
 */
export function presentationTemplateSkillInstruction(): string {
  return [
    `Turning an uploaded deck (.pptx, .ppt, or .pdf) into a reusable presentation template follows the ${PRESENTATION_TEMPLATE_SKILL_PATH} guide, which is not mounted as a skill.`,
    `Clone it first with \`gh repo clone ${PRESENTATION_TEMPLATE_SKILL_REPO} <dir> -- --depth 1 -b ${PRESENTATION_TEMPLATE_SKILL_BRANCH}\`, read \`<dir>/${PRESENTATION_TEMPLATE_SKILL_PATH}/SKILL.md\`, and follow it exactly, including its page-rendering and publish steps.`,
    `The guide's readers cover .pptx and .pdf only, so convert a legacy binary .ppt to one of those first and run the guide on the converted deck.`,
  ].join(" ");
}
