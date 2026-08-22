import { command, computed, state } from "ccstate";
import {
  presentationTemplatesContract,
  type PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { presentationTemplateImportEnabled$ } from "./presentation-template-import.ts";

export type { PresentationTemplateSummary };

const ownPresentationTemplatesVersion$ = state(0);

/**
 * The decks this user has already imported, newest first, as the picker lists
 * them.
 *
 * Answering with an empty catalog while the switch is off is not a fallback for
 * a failed request: the route replies `403` to a caller without the switch, and
 * `accept` would surface that as an error toast on a dialog the user opened to
 * browse built-in templates.
 */
export const ownPresentationTemplates$ = computed(
  async (get): Promise<readonly PresentationTemplateSummary[]> => {
    if (!get(presentationTemplateImportEnabled$)) {
      return [];
    }
    get(ownPresentationTemplatesVersion$);
    const client = get(apiClient$)(presentationTemplatesContract);
    const result = await accept(client.list(), [200]);
    return result.body;
  },
);

/**
 * Refetch the catalog.
 *
 * The picker calls this as it opens rather than reading a session-long cache,
 * because both facts it renders go stale on their own: an import finishes
 * minutes after the deck was handed over, in a thread the user navigates away
 * from, and every cover URL is a short-lived signed URL.
 */
export const refreshOwnPresentationTemplates$ = command(({ get, set }) => {
  set(
    ownPresentationTemplatesVersion$,
    get(ownPresentationTemplatesVersion$) + 1,
  );
});
