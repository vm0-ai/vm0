import {
  PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID,
  PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH,
} from "./presentation-reverse-template-resource";

const PRESENTATION_TEMPLATE_RESOURCE_DIR = "./generated/resources";

/**
 * Tell a run how to reach the guide.
 *
 * One sentence pair, carried by the standing agent-tools prompt so that any
 * deck reaches these instructions — dropped in the chat box, picked through
 * the import dialog, or asked for in words — without a user-visible message
 * having to spell the pull out.
 */
export function presentationTemplateSkillInstruction(): string {
  const skillPath = `${PRESENTATION_TEMPLATE_RESOURCE_DIR}/${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH}/SKILL.md`;
  return [
    `Turning an uploaded deck (.pptx, .ppt, or .pdf) into a reusable presentation template follows the ${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_PATH} guide, which is not mounted as a skill.`,
    `Pull it first with \`okou resource pull ${PRESENTATION_REVERSE_TEMPLATE_RESOURCE_ID} --dir ${PRESENTATION_TEMPLATE_RESOURCE_DIR}\`, read \`${skillPath}\`, and follow it exactly, including its page-rendering and publish steps.`,
  ].join(" ");
}
