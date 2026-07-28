import type { BrandName } from "../../signals/branding.ts";

const CLERK_NOT_ALLOWED_ACCESS_ERROR_TEXT = "Access is not allowed.";

export function getClerkLocalization(brandName: BrandName) {
  return {
    unstable__errors: {
      not_allowed_access: CLERK_NOT_ALLOWED_ACCESS_ERROR_TEXT,
      user_banned: `Account access suspended because activity on this account violated the ${brandName} Terms of Use. If you have questions, contact support@vm0.ai.`,
    },
  };
}
