import { createHmac, timingSafeEqual } from "node:crypto";

import { now } from "./time";

interface SlackSignatureHeaders {
  readonly signature: string;
  readonly timestamp: string;
}

const SLACK_REPLAY_WINDOW_SECONDS = 60 * 5;

export function getSlackSignatureHeaders(
  headers: Headers,
): SlackSignatureHeaders | null {
  const signature = headers.get("x-slack-signature");
  const timestamp = headers.get("x-slack-request-timestamp");

  if (!signature || !timestamp) {
    return null;
  }

  return { signature, timestamp };
}

export function verifySlackSignature(args: {
  readonly signingSecret: string;
  readonly signature: string;
  readonly timestamp: string;
  readonly body: string;
}): boolean {
  const currentTime = Math.floor(now() / 1000);
  const requestTime = Number.parseInt(args.timestamp, 10);
  if (
    !Number.isFinite(requestTime) ||
    Math.abs(currentTime - requestTime) > SLACK_REPLAY_WINDOW_SECONDS
  ) {
    return false;
  }

  const baseString = `v0:${args.timestamp}:${args.body}`;
  const expectedSignature = `v0=${createHmac("sha256", args.signingSecret)
    .update(baseString)
    .digest("hex")}`;

  const actual = Buffer.from(args.signature);
  const expected = Buffer.from(expectedSignature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
