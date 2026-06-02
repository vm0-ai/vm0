export const BANNED_ACCOUNT_ERROR_CODE = "user_banned";
export const TERMS_OF_USE_URL = "https://www.vm0.ai/terms-of-use";
export const SUPPORT_EMAIL = "support@vm0.ai";

const BANNED_ACCOUNT_MESSAGE =
  "Your account access has been suspended because activity on this account violated the vm0 Terms of Use. Review https://www.vm0.ai/terms-of-use. If you have questions, contact support@vm0.ai.";

export const VM0_CLERK_LOCALIZATION = {
  unstable__errors: {
    not_allowed_access: BANNED_ACCOUNT_MESSAGE,
    user_banned: BANNED_ACCOUNT_MESSAGE,
  },
};
