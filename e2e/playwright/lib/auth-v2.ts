import { randomBytes } from "node:crypto";

import {
  createOrganization,
  deleteOrganizationById,
  deleteUserByEmail,
  generateTestEmail,
} from "./clerk-api";

const DEFAULT_CLERK_API_BASE = "https://api.clerk.com/v1";

export const AUTH_V2_TEST_OTP = "424242";

interface AuthV2PasswordIdentity {
  readonly email: string;
  readonly password: string;
}

/**
 * Tracks every identity allocated by one Auth v2 test. Exact deletion runs in
 * fixture teardown; the existing generation cleanup remains the final safety
 * net when a worker or job is interrupted.
 */
export class AuthV2TestResources {
  readonly #emails: string[] = [];
  readonly #organizationIds: string[] = [];

  allocateEmail(): string {
    const email = generateTestEmail("playwright");
    maskInGitHubActions(email);
    this.#emails.push(email);
    return email;
  }

  createPassword(): string {
    const password = createStrongTestPassword();
    maskInGitHubActions(password);
    return password;
  }

  async createPasswordIdentity(
    organizationNames: readonly string[] = [],
  ): Promise<AuthV2PasswordIdentity> {
    const email = this.allocateEmail();
    const password = this.createPassword();
    const userId = await createPasswordUser(email, password);

    for (const organizationName of organizationNames) {
      const organizationId = await createOrganization(
        organizationName,
        userId,
        "playwright",
      );
      this.#organizationIds.push(organizationId);
    }

    return { email, password };
  }

  async cleanup(): Promise<void> {
    const cleanupErrors: Error[] = [];
    for (const organizationId of [...this.#organizationIds].reverse()) {
      try {
        await deleteOrganizationById(organizationId);
      } catch {
        cleanupErrors.push(safeCleanupError("organization"));
      }
    }
    for (const email of [...this.#emails].reverse()) {
      try {
        await deleteUserByEmail(email);
      } catch {
        cleanupErrors.push(safeCleanupError("user"));
      }
    }
    this.#organizationIds.length = 0;
    this.#emails.length = 0;

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Auth v2 exact Clerk resource cleanup failed",
      );
    }
  }
}

function createStrongTestPassword(): string {
  return `${randomBytes(18).toString("base64url")}aA1!`;
}

function maskInGitHubActions(value: string): void {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

async function createPasswordUser(
  email: string,
  password: string,
): Promise<string> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY environment variable is required");
  }
  const apiBase = clerkApiBase();
  let response: Response;
  try {
    response = await fetch(`${apiBase}/users`, {
      body: JSON.stringify({
        email_address: [email],
        first_name: "Auth",
        last_name: "Browser",
        legal_accepted_at: new Date().toISOString(),
        password,
      }),
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  } catch (cause) {
    throw new Error("create Auth v2 Clerk user request failed", { cause });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `create Auth v2 Clerk user failed with HTTP ${response.status}`,
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (cause) {
    throw new Error("create Auth v2 Clerk user returned invalid JSON", {
      cause,
    });
  }
  if (!isRecord(data) || typeof data.id !== "string") {
    throw new Error("create Auth v2 Clerk user returned an invalid shape");
  }
  return data.id;
}

function clerkApiBase(): string {
  const testApiBase = process.env.CLERK_API_TEST_BASE_URL;
  if (!testApiBase) {
    return DEFAULT_CLERK_API_BASE;
  }
  const url = new URL(testApiBase);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("CLERK_API_TEST_BASE_URL must use an HTTP 127.0.0.1 URL");
  }
  return testApiBase.replace(/\/$/, "");
}

function safeCleanupError(resource: "organization" | "user") {
  return new Error(`Failed to delete exact Auth v2 Clerk ${resource}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
