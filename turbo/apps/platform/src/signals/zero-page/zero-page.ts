import { command } from "ccstate";
import { createElement } from "react";
import { ZeroPage } from "../../views/zero-page/zero-page.tsx";
import { updatePage$ } from "../react-router.ts";

export const setupZeroPage$ = command(({ set }) => {
  set(updatePage$, createElement(ZeroPage));
});
