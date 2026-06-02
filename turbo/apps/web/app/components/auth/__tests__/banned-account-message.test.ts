import { describe, expect, it } from "vitest";
import {
  CLERK_BANNED_ACCOUNT_ERROR_TEXT,
  CLERK_NOT_ALLOWED_ACCESS_ERROR_TEXT,
  VM0_CLERK_LOCALIZATION,
} from "../banned-account-message";

describe("VM0_CLERK_LOCALIZATION", () => {
  it("uses separate text for banned accounts and regular access errors", () => {
    expect(VM0_CLERK_LOCALIZATION.unstable__errors.user_banned).toBe(
      CLERK_BANNED_ACCOUNT_ERROR_TEXT,
    );
    expect(VM0_CLERK_LOCALIZATION.unstable__errors.not_allowed_access).toBe(
      CLERK_NOT_ALLOWED_ACCESS_ERROR_TEXT,
    );
    expect(CLERK_BANNED_ACCOUNT_ERROR_TEXT).not.toBe(
      CLERK_NOT_ALLOWED_ACCESS_ERROR_TEXT,
    );
  });
});
