import { command } from "ccstate";
import { createElement } from "react";
import { AppSkeleton } from "../views/zero-page/app-skeleton.tsx";
import { DefaultErrorFallback } from "../views/default-error-boundary.tsx";
import { updatePage$ } from "./react-router.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";

export const setupSkeletonPage$ = command(({ set }) => {
  set(updatePage$, createElement(AppSkeleton, { visible: true }));
});

export const setupErrorPage$ = command(async ({ set }, signal: AbortSignal) => {
  set(
    updatePage$,
    createElement(DefaultErrorFallback, {
      error: new Error("Preview"),
      errorInfo: { componentStack: "" },
    }),
  );
  await set(hideAppSkeleton$, signal);
});
