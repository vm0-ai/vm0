/**
 * How a user's own presentation template is named in a selection.
 *
 * The picker sends the same `templateId` field as a built-in template, so a
 * private template needs a namespace that a built-in id can never collide
 * with. Built-in ids are registry slugs; `user-template:` marks the rest of
 * the string as a `presentation_templates` row id.
 */
const USER_PRESENTATION_TEMPLATE_ID_PREFIX = "user-template:";

/**
 * The canonical UUID form. Anything else is not a template id, including a
 * prefixed string carrying a slug, a path, or a second prefix.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function formatUserPresentationTemplateId(templateId: string): string {
  return `${USER_PRESENTATION_TEMPLATE_ID_PREFIX}${templateId}`;
}

/**
 * Read the row id out of a selection, or `undefined` when the selection names
 * a built-in template.
 *
 * Syntax only: a well-formed id says nothing about whether that row exists or
 * whether this caller may read it. Both are decided against the database at
 * send time, which is the authority for a row this identifier points at.
 */
export function parseUserPresentationTemplateId(
  templateId: string,
): string | undefined {
  if (!templateId.startsWith(USER_PRESENTATION_TEMPLATE_ID_PREFIX)) {
    return undefined;
  }
  const rowId = templateId.slice(USER_PRESENTATION_TEMPLATE_ID_PREFIX.length);
  return UUID_PATTERN.test(rowId) ? rowId : undefined;
}

/**
 * Whether a selection is asking for a private template at all.
 *
 * Separate from parsing because a malformed private id must be rejected rather
 * than quietly treated as a built-in slug that happens not to exist: the two
 * produce different errors, and only one of them is the user's fault.
 */
export function isUserPresentationTemplateId(templateId: string): boolean {
  return templateId.startsWith(USER_PRESENTATION_TEMPLATE_ID_PREFIX);
}

/**
 * Where the guidance package is mounted for the run, relative to the working
 * directory.
 *
 * A directory rather than a skills-root mount, because the skills root is
 * chosen per framework inside run creation while this path has to appear in a
 * prompt built before a framework exists. It sits beside the built-in
 * templates' `./generated/resources/<slug>`, so both kinds of package are
 * somewhere the agent already looks.
 *
 * The leaf is the row id, not the user's title: a title is arbitrary text that
 * two templates can share, and one message may attach several templates.
 */
export function userPresentationTemplateDirectory(templateId: string): string {
  return `generated/presentation-template/${templateId}`;
}
