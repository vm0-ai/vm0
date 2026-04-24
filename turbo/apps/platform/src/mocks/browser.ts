/**
 * MSW browser worker setup.
 *
 * Used by Vitest Browser Tests so Chrome exercises the same mock handlers as
 * the existing happy-dom test suite without using the Node request interceptor.
 */

import { setupWorker } from "msw/browser";
import { handlers } from "./handlers/index.ts";

export const worker = setupWorker(...handlers);
