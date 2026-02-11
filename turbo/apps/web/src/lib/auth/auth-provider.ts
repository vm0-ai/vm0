import { auth, clerkClient } from "@clerk/nextjs/server";
import { SELF_HOSTED_USER_ID, SELF_HOSTED_USER_EMAIL } from "./constants";

export { SELF_HOSTED_USER_ID } from "./constants";

/**
 * Authentication provider interface.
 *
 * Abstracts over the auth backend (Clerk for SaaS, local for self-hosted).
 * This enables easy switching and future additions (e.g., JWT-based multi-user).
 */
interface AuthProvider {
  getUserId(): Promise<string | null>;
  getUserEmail(userId: string): Promise<string>;
}

/**
 * SaaS mode: delegates to Clerk for session-based auth.
 */
function createClerkAuthProvider(): AuthProvider {
  return {
    async getUserId() {
      const { userId } = await auth();
      return userId;
    },

    async getUserEmail(userId: string) {
      const client = await clerkClient();
      const user = await client.users.getUser(userId);
      const email = user.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId,
      )?.emailAddress;
      return email || "";
    },
  };
}

/**
 * Self-hosted single-user mode: always returns the default user.
 */
function createLocalAuthProvider(): AuthProvider {
  return {
    async getUserId() {
      return SELF_HOSTED_USER_ID;
    },

    async getUserEmail() {
      return SELF_HOSTED_USER_EMAIL;
    },
  };
}

let _provider: AuthProvider | undefined;

export function getAuthProvider(): AuthProvider {
  if (!_provider) {
    _provider =
      process.env.SELF_HOSTED === "true"
        ? createLocalAuthProvider()
        : createClerkAuthProvider();
  }
  return _provider;
}

/** @internal Clear cached provider (for tests only). */
export function resetAuthProvider(): void {
  _provider = undefined;
}
