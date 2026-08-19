import { PRESENTATION_TEMPLATE_IMPORT_SKILL_NAME } from "@okouai/core/seed-skills";

/**
 * The message the owner sees in the analysis thread.
 *
 * It stays short on purpose. The extraction contract lives in the
 * `presentation-template-import` skill, so it can be revised in the skills
 * repository without an API deploy, and the thread reads as a task rather than
 * as a specification.
 */
export function templateImportPrompt(templateId: string): string {
  return `Import presentation template ${templateId}. Follow the ${PRESENTATION_TEMPLATE_IMPORT_SKILL_NAME} skill exactly.`;
}
