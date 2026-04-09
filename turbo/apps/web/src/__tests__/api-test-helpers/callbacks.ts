import type { NextRequest } from "next/server";
import { computeHmacSignature } from "../../lib/infra/callback/hmac";
import { createTestRequest } from "./core";

/**
 * Create a HMAC-signed POST request for testing callback endpoints.
 *
 * @param url - The URL for the request
 * @param body - The request body (will be JSON-serialized)
 * @param secret - The HMAC secret to sign with
 * @param options - Optional overrides for testing error scenarios
 * @param options.invalidSignature - If true, uses "invalid-signature" instead of computed HMAC
 * @param options.expiredTimestamp - If true, uses a timestamp 10 minutes in the past
 * @returns A NextRequest with HMAC signature headers
 */
export function createSignedCallbackRequest(
  url: string,
  body: unknown,
  secret: string,
  options?: {
    invalidSignature?: boolean;
    expiredTimestamp?: boolean;
  },
): NextRequest {
  const timestamp = options?.expiredTimestamp
    ? Math.floor(Date.now() / 1000) - 600
    : Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(body);
  const signature = options?.invalidSignature
    ? "invalid-signature"
    : computeHmacSignature(payload, secret, timestamp);
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
