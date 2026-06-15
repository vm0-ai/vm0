/**
 * Test helpers for the presigned upload flow.
 *
 * Production uploads run in two steps:
 *   1. POST /api/zero/uploads/prepare  → JSON { id, uploadUrl, url, ... }
 *   2. PUT  <uploadUrl>                → 200 (direct to R2)
 *
 * These helpers register MSW handlers for both steps so individual tests only
 * have to describe the resulting file metadata, not the wire protocol.
 */

import { http, HttpResponse, type HttpHandler } from "msw";
import { createDeferredPromise } from "../signals/utils.ts";
import { createMockHttp, type SignalContextLike } from "./msw-contract.ts";

interface MockUploadResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** Final public artifact URL returned to the app. */
  url: string;
}

const MOCK_PUT_BASE = "https://mock-upload.r2.test";

function uploadUrlFor(id: string): string {
  return `${MOCK_PUT_BASE}/${encodeURIComponent(id)}`;
}

/**
 * Resolve the prepare step with the given metadata, and accept the subsequent
 * PUT upload so the file appears fully uploaded.
 */
export function mockUploadSuccess(result: MockUploadResult): HttpHandler[] {
  const uploadUrl = uploadUrlFor(result.id);
  return [
    // mockApi cannot be used here: /api/zero/uploads/prepare is an internal
    // helper endpoint with no ts-rest contract (see route.ts — returns
    // presigned URLs, not domain data).
    http.post("*/api/zero/uploads/prepare", () => {
      return HttpResponse.json({ ...result, uploadUrl });
    }),
    http.put(uploadUrl, () => {
      return new HttpResponse(null, { status: 200 });
    }),
  ];
}

/**
 * Like mockUploadSuccess, but the PUT step never resolves — useful for tests
 * that need to observe the "uploading" UI state.
 */
export function mockUploadPending(
  context: SignalContextLike,
  result: MockUploadResult,
): HttpHandler[] {
  const uploadUrl = uploadUrlFor(result.id);
  const mockHttp = createMockHttp(context);
  return [
    // mockApi cannot be used here: /api/zero/uploads/prepare is an internal
    // helper endpoint with no ts-rest contract.
    http.post("*/api/zero/uploads/prepare", () => {
      return HttpResponse.json({ ...result, uploadUrl });
    }),
    mockHttp.put(uploadUrl, ({ signal }) => {
      return createDeferredPromise<never>(signal).promise;
    }),
  ];
}
