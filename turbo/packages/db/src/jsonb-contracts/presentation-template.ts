/**
 * Why a presentation template import failed.
 *
 * `code` is the stable identifier the picker maps to a localized string;
 * `message` carries the detail for support and debugging and is not shown as
 * the primary explanation, because it is written by the import run and has no
 * guaranteed language.
 */
export interface PresentationTemplateError {
  readonly code: string;
  readonly message: string;
}
