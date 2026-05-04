import { command } from "ccstate";
import { setRootSignal$ } from "./root-signal.ts";
import { createElement } from "react";
import { Text } from "react-native";
import { updatePage$ } from "./react-router.ts";

/**
 * Root bootstrap command. Initializes the app with the root AbortSignal,
 * then renders the UI shell.
 */
export const bootstrap$ = command(
  async ({ set }, render: () => void, signal: AbortSignal) => {
    set(setRootSignal$, signal);

    // Set initial page — placeholder home screen
    set(updatePage$, createElement(Text, null, "vm0 Mobile"));

    render();

    signal.throwIfAborted();
  },
);
