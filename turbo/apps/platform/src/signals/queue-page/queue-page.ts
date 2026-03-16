import { command } from "ccstate";
import { createElement } from "react";
import { QueuePage } from "../../views/queue-page/queue-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { startQueuePolling$ } from "./queue-signals.ts";

export const setupQueuePage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(QueuePage));
  await set(startQueuePolling$, signal);
});
