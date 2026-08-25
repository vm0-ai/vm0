import {
  PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID,
  PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH,
} from "./presentation-reverse-template-resource";

const PRESENTATION_TEMPLATE_RESOURCE_DIR = "./generated/resources";

/**
 * Tell a run how to reach the guide.
 *
 * One sentence pair, used both by the import message the template picker sends
 * and by the standing agent-tools prompt, so a deck dropped in the chat box
 * reaches the same instructions as one picked through the dialog.
 */
export function presentationTemplateSkillInstruction(): string {
  const skillPath = `${PRESENTATION_TEMPLATE_RESOURCE_DIR}/${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH}/SKILL.md`;
  return [
    `Turning an uploaded deck (.pptx, .ppt, or .pdf) into a reusable presentation template follows the ${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH} guide, which is not mounted as a skill.`,
    `Pull it first with \`okou resource pull ${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID} --dir ${PRESENTATION_TEMPLATE_RESOURCE_DIR}\`, read \`${skillPath}\`, and follow it exactly, including its page-rendering and publish steps.`,
  ].join(" ");
}
