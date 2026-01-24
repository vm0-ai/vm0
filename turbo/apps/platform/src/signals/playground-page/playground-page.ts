import { command } from "ccstate";
import { updatePage$ } from "../react-router";
import { createElement } from "react";
import { PlaygroundPage } from "../../views/playground-page/playground-page";

export const setupPlaygroundPage$ = command(({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(PlaygroundPage));
  signal.throwIfAborted();
});
