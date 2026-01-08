import { command } from "ccstate";
import { createElement } from "react";
import { HomePage } from "../../views/home/home-page.tsx";
import { updatePage$ } from "../react-router.ts";

export const setupHomePage$ = command(({ set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  set(updatePage$, createElement(HomePage));
});
