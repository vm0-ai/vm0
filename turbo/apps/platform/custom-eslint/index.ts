/**
 * Custom ESLint plugin for ccstate patterns.
 *
 * This plugin enforces architectural patterns for the ccstate-based app:
 * - signal-dollar-suffix: Signal variables must end with $
 * - no-export-state: Don't export state() directly
 * - signal-check-await: Check AbortSignal after await in commands
 * - tsx-in-views: TSX files only allowed in views/
 * - no-catch-abort: Enforce throwIfAbort in catch blocks
 * - no-package-variable: Prevent mutable vars at package scope
 * - no-get-signal: Prevent getting AbortSignal from state
 * - test-context-in-hooks: Ensure testContext() in test hooks
 * - computed-const-args-package-scope: Enforce package scope for constant functions
 * - no-store-in-params: Prevent Store type in function params
 */

import signalDollarSuffix from "./rules/signal-dollar-suffix.ts";
import noExportState from "./rules/no-export-state.ts";
import signalCheckAwait from "./rules/signal-check-await.ts";
import tsxInViews from "./rules/tsx-in-views.ts";
import noCatchAbort from "./rules/no-catch-abort.ts";
import noPackageVariable from "./rules/no-package-variable.ts";
import noGetSignal from "./rules/no-get-signal.ts";
import testContextInHooks from "./rules/test-context-in-hooks.ts";
import computedConstArgsPackageScope from "./rules/computed-const-args-package-scope.ts";
import noStoreInParams from "./rules/no-store-in-params.ts";
import setupPageRender from "./rules/setup-page-render.ts";

const plugin = {
  meta: {
    name: "ccstate",
    version: "1.0.0",
  },
  rules: {
    "signal-dollar-suffix": signalDollarSuffix,
    "no-export-state": noExportState,
    "signal-check-await": signalCheckAwait,
    "tsx-in-views": tsxInViews,
    "no-catch-abort": noCatchAbort,
    "no-package-variable": noPackageVariable,
    "no-get-signal": noGetSignal,
    "test-context-in-hooks": testContextInHooks,
    "computed-const-args-package-scope": computedConstArgsPackageScope,
    "no-store-in-params": noStoreInParams,
    "setup-page-render": setupPageRender,
  },
};

export default plugin;
