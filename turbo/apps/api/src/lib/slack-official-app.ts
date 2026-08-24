import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

export const OFFICIAL_SLACK_PUBLIC_BRAND = "okou" satisfies PublicBrand;
export const OFFICIAL_SLACK_APP_NAME = "Okou";
export const OFFICIAL_SLACK_PRIMARY_COMMAND = "/okou";
export const OFFICIAL_SLACK_LEGACY_COMMAND = "/zero";

export function officialSlackBotMention(botUserId: string): string {
  return `<@${botUserId}>`;
}
