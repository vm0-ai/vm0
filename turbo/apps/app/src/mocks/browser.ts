/**
 * MSW Browser Setup
 *
 * This configures MSW to run in the browser using a Service Worker.
 * Use this for development mode API mocking.
 *
 * To enable in development:
 * 1. Run `npx msw init ./public` to generate the service worker file
 * 2. Import and start the worker in your main.ts:
 *
 *    if (import.meta.env.DEV) {
 *      const { worker } = await import('./mocks/browser.ts');
 *      await worker.start();
 *    }
 */

import { setupWorker } from "msw/browser";
import { handlers } from "./handlers/index.ts";

export const worker = setupWorker(...handlers);
