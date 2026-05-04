import { command } from "ccstate";
import { setRootSignal$ } from "./root-signal.ts";
import { createElement } from "react";
import { Text } from "react-native";
import { updatePage$ } from "./react-router.ts";

export const bootstrap$ = command(
  ({ set }, render: () => void, signal: AbortSignal) => {
    set(setRootSignal$, signal);

    // Set initial page — placeholder home screen
    set(updatePage$, createElement(Text, null, "vm0 Mobile"));

    render();
  },
);
