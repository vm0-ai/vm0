import type { NextRequest } from "next/server";
import { computeHmacSignature } from "../../lib/infra/callback/hmac";
import { createTestRequest } from "./core";

/**
 * Create a HMAC-signed POST request for testing callback endpoints.
 *
 * @param url - The URL for the request
 * @param body - The request body (will be JSON-serialized)
 * @param secret - The HMAC secret to sign with
 * @returns A NextRequest with HMAC signature headers
 */
export function createSignedCallbackRequest(
  url: string,
  body: unknown,
  secret: string,
): NextRequest {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(body);
  const signature = computeHmacSignature(payload, secret, timestamp);
  return createTestRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vm0-signature": signature,
      "x-vm0-timestamp": String(timestamp),
    },
    body: payload,
  });
}
