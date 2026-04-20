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
 * - no-side-effect-in-render: Prevent side-effect calls (set, detach) directly in render
 * - no-non-zero-api: Enforce that platform app only calls /api/zero/ endpoints
 * - command-async-signal: Async commands must accept AbortSignal as last param
 * - no-getter-setter-params: Functions must not accept ccstate Getter/Setter — use command()
 * - no-new-abort-controller: Disallow new AbortController() — use signal hierarchy
 * - no-direct-local-storage: Disallow direct localStorage access — use localStorageSignals()
 * - no-detach-in-signals: Disallow detach() in signals/ — use await or signal chain
 * - no-direct-fetch: Disallow direct fetch$ usage — use zeroClient$ instead
 * - no-empty-promise-catch: Disallow .catch(() => {}) — use detach() for proper promise tracking
 * - no-test-delay: Disallow manual delays/timers in tests — use createDeferredPromise + waitFor
 * - require-accept: Enforce that zeroClient$ calls are wrapped in accept()
 * - no-get-by-role-name: Avoid *ByRole(role, { name }) for text-content roles — causes ~300ms/call slowdown in happy-dom
 * - no-raw-msw-http: Disallow raw http.* MSW handlers for internal /api/zero/* paths — use mockApi(contract.route, ...)
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
import noSideEffectInRender from "./rules/no-side-effect-in-render.ts";
import noNonZeroApi from "./rules/no-non-zero-api.ts";
import commandAsyncSignal from "./rules/command-async-signal.ts";
import noGetterSetterParams from "./rules/no-getter-setter-params.ts";
import noNewAbortController from "./rules/no-new-abort-controller.ts";
import preferUserEvent from "./rules/prefer-user-event.ts";
import noDirectLocalStorage from "./rules/no-direct-local-storage.ts";
import noDetachInSignals from "./rules/no-detach-in-signals.ts";
import noDirectFetch from "./rules/no-direct-fetch.ts";
import noEmptyPromiseCatch from "./rules/no-empty-promise-catch.ts";
import noVoidStatement from "./rules/no-void-statement.ts";
import noAbortSwallower from "./rules/no-abort-swallower.ts";
import noTestDelay from "./rules/no-test-delay.ts";
import requireAccept from "./rules/require-accept.ts";
import noGetByRoleName from "./rules/no-get-by-role-name.ts";
import noUserClearTab from "./rules/no-user-clear-tab.ts";
import noDuplicateRouteParam from "./rules/no-duplicate-route-param.ts";
import noRawMswHttp from "./rules/no-raw-msw-http.ts";

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
    "no-side-effect-in-render": noSideEffectInRender,
    "no-non-zero-api": noNonZeroApi,
    "command-async-signal": commandAsyncSignal,
    "no-getter-setter-params": noGetterSetterParams,
    "no-new-abort-controller": noNewAbortController,
    "prefer-user-event": preferUserEvent,
    "no-direct-local-storage": noDirectLocalStorage,
    "no-detach-in-signals": noDetachInSignals,
    "no-direct-fetch": noDirectFetch,
    "no-empty-promise-catch": noEmptyPromiseCatch,
    "no-void-statement": noVoidStatement,
    "no-abort-swallower": noAbortSwallower,
    "no-test-delay": noTestDelay,
    "require-accept": requireAccept,
    "no-get-by-role-name": noGetByRoleName,
    "no-user-clear-tab": noUserClearTab,
    "no-duplicate-route-param": noDuplicateRouteParam,
    "no-raw-msw-http": noRawMswHttp,
  },
};

export default plugin;
