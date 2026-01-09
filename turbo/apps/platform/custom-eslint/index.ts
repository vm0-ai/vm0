/**
 * Custom ESLint plugin for ccstate patterns.
 *
 * This plugin enforces architectural patterns for the ccstate-based app:
 * - signal-dollar-suffix: Signal variables must end with $
 * - no-export-state: Don't export state() directly
 * - signal-check-await: Check AbortSignal after await in commands
 * - tsx-in-views: TSX files only allowed in views/
 */

import signalDollarSuffix from "./rules/signal-dollar-suffix.ts";
import noExportState from "./rules/no-export-state.ts";
import signalCheckAwait from "./rules/signal-check-await.ts";
import tsxInViews from "./rules/tsx-in-views.ts";

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
  },
};

export default plugin;
