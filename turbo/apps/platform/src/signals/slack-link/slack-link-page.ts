import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { initSlackLink$ } from "./slack-link.ts";
import { SlackLinkPage } from "../../views/slack-link/slack-link-page.tsx";

export const setupSlackLinkPage$ = command(async ({ set }) => {
  set(updatePage$, createElement(SlackLinkPage));
  await set(initSlackLink$);
});
