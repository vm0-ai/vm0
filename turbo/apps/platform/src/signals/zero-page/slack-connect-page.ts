import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { ZeroSlackConnectPage } from "../../views/zero-page/zero-slack-connect-page.tsx";
import { detach, Reason } from "../utils.ts";
import {
  resetSlackConnectState$,
  initSlackConnectPage$,
} from "./slack-connect-signals.ts";

export const setupSlackConnectPage$ = command(({ set }) => {
  set(resetSlackConnectState$);
  set(updatePage$, createElement(ZeroSlackConnectPage));
  detach(set(initSlackConnectPage$), Reason.Entrance);
});
