import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { ZeroSlackConnectPage } from "../../views/zero-page/zero-slack-connect-page.tsx";

export const setupSlackConnectPage$ = command(({ set }) => {
  set(updatePage$, createElement(ZeroSlackConnectPage));
});
