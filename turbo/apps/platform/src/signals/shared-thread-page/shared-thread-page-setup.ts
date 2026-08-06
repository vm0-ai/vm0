import { sharedThreadsContract } from "@vm0/api-contracts/contracts/shared-threads";
import { command } from "ccstate";
import { createElement } from "react";

import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { SharedThreadPage } from "../../views/shared-thread-page/shared-thread-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { zeroClient$ } from "../api-client.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { pathParams$ } from "../route.ts";
import { updatePage$ } from "../react-router.ts";

export const setupSharedThreadPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(pathParams$);
    const id = String(params?.id ?? "");
    const client = get(zeroClient$)(sharedThreadsContract);
    const result = await accept(
      client.get({ params: { id }, fetchOptions: { signal } }),
      [200, 404],
      signal,
    );
    const sharedThread = result.status === 200 ? result.body : null;
    set(
      updateDocumentTitle$,
      sharedThread?.title ??
        i18n.t(($) => {
          return $.sharedThread.notFoundTitle;
        }),
    );
    set(updatePage$, createElement(SharedThreadPage, { sharedThread }));
    await set(hideAppSkeleton$, signal);
  },
);
