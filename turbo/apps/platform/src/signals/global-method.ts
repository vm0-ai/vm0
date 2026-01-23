import { command } from "ccstate";
import { logger } from "./log";

const L = logger("GlobalMethod");

export const setupGlobalMethod$ = command((_, signal: AbortSignal) => {
  L.debug("Setting up global method vm0");
  window._vm0 = {};

  signal.addEventListener("abort", () => {
    L.debug("Cleaning up global method vm0");
    delete window._vm0;
  });
});
