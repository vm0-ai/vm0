import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../../lib/env";
import { now } from "../external/time";

const CONNECT_LINK_MAX_AGE_SECONDS = 10 * 60;

function payload(args: {
  readonly tenantKey: string;
  readonly openId: string;
  readonly chatId: string;
  readonly timestamp: number;
}): string {
  return JSON.stringify([
    args.tenantKey,
    args.openId,
    args.chatId,
    args.timestamp,
  ]);
}

function signFeishuConnectToken(args: {
  readonly tenantKey: string;
  readonly openId: string;
  readonly chatId: string;
  readonly timestamp: number;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(payload(args))
    .digest("hex");
}

export function verifyFeishuConnectToken(args: {
  readonly tenantKey: string;
  readonly openId: string;
  readonly chatId: string;
  readonly timestamp: number;
  readonly signature: string;
}): boolean {
  const currentTimestamp = Math.floor(now() / 1000);
  if (
    args.timestamp > currentTimestamp + 60 ||
    currentTimestamp - args.timestamp > CONNECT_LINK_MAX_AGE_SECONDS
  ) {
    return false;
  }
  const expected = Buffer.from(
    signFeishuConnectToken({
      tenantKey: args.tenantKey,
      openId: args.openId,
      chatId: args.chatId,
      timestamp: args.timestamp,
    }),
    "utf8",
  );
  const actual = Buffer.from(args.signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function buildFeishuConnectUrl(args: {
  readonly tenantKey: string;
  readonly openId: string;
  readonly chatId: string;
}): string {
  const timestamp = Math.floor(now() / 1000);
  const params = new URLSearchParams({
    tenantKey: args.tenantKey,
    openId: args.openId,
    chatId: args.chatId,
    ts: String(timestamp),
    sig: signFeishuConnectToken({ ...args, timestamp }),
  });
  return `${env("VM0_WEB_URL")}/api/zero/feishu/connect?${params.toString()}`;
}
