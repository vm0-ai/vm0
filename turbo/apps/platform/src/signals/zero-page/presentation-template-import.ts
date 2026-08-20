import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { featureSwitch$ } from "../external/feature-switch.ts";
import type { ComposerSignals } from "./composer-signals.ts";

/**
 * Decks a user can hand over. Both end up as ordered page images the same way,
 * so nothing downstream distinguishes them.
 */
export const PRESENTATION_TEMPLATE_IMPORT_ACCEPT = ".pptx,.pdf";

/**
 * The message the deck is sent with.
 *
 * Kept as a plain sentence on purpose: importing a template is not a special
 * protocol, it is a chat message with a file attached, and the user should be
 * able to read what was said on their behalf — and edit it before sending if
 * they want something different.
 */
const PRESENTATION_TEMPLATE_IMPORT_PROMPT =
  "Analyse this deck and save its visual language as a reusable presentation template.";

export const presentationTemplateImportEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.PresentationTemplates] ?? false;
});

/**
 * Attach the deck to the composer and send it.
 *
 * This deliberately reuses the ordinary composer path rather than adding an
 * upload protocol of its own: the deck becomes a chat attachment, the message
 * is sent, and the existing new-thread flow creates the thread and navigates
 * into it. The user then watches the analysis happen and can interrupt or
 * follow up, which a background job could not offer.
 */
export const importPresentationTemplateDeck$ = command(
  async (
    { get, set },
    args: { readonly signals: ComposerSignals; readonly file: File },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { signals, file } = args;
    await set(signals.draft.uploadAttachment$, file, signal);
    signal.throwIfAborted();
    set(signals.draft.setDraftInput$, PRESENTATION_TEMPLATE_IMPORT_PROMPT);

    const action = await get(signals.submission.primaryAction$);
    signal.throwIfAborted();
    return await set(signals.submission.submitCurrentInput$, action, signal);
  },
);
