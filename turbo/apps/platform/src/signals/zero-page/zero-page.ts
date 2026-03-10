import { command } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { initZeroOnboarding$ } from "./zero-onboarding.ts";

export const setupZeroPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroPage));

  await set(initZeroOnboarding$, signal);
});
