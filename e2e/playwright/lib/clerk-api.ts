import { randomBytes } from "node:crypto";

const CLERK_API_BASE = "https://api.clerk.com/v1";
const CLERK_RETRY_DELAYS_MS = [500, 1_500] as const;

interface ClerkEmailAddress {
  readonly email_address: string;
}

interface ClerkUserSummary {
  readonly id: string;
  readonly email_addresses: readonly ClerkEmailAddress[];
}

interface ClerkRequestOptions {
  readonly retryTransientFailures?: boolean;
}

function getClerkHeaders(): Record<string, string> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY environment variable is required");
  }
  return {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };
}

export function generateTestEmail(): string {
  const jobRef = process.env.JOB_REF ?? "local";
  const randHex = randomBytes(4).toString("hex");
  return `${jobRef}+clerk_test@e2e-browser-${randHex}.ai`;
}

export async function createUser(email: string): Promise<string> {
  const response = await requestClerk("create Clerk user", "/users", {
    method: "POST",
    headers: getClerkHeaders(),
    body: JSON.stringify({
      email_address: [email],
      skip_password_requirement: true,
      legal_accepted_at: new Date().toISOString(),
    }),
  });
  const data = await readClerkJson(response, "create Clerk user");
  if (!hasStringProperty(data, "id")) {
    throw new Error(`Failed to create Clerk user: ${JSON.stringify(data)}`);
  }
  return data.id;
}

export async function createOrganization(
  name: string,
  createdByUserId: string,
): Promise<string> {
  const response = await requestClerk(
    "create Clerk organization",
    "/organizations",
    {
      method: "POST",
      headers: getClerkHeaders(),
      body: JSON.stringify({ name, created_by: createdByUserId }),
    },
  );
  const data = await readClerkJson(response, "create Clerk organization");
  if (!hasStringProperty(data, "id")) {
    throw new Error(
      `Failed to create Clerk organization: ${JSON.stringify(data)}`,
    );
  }
  await updateOrganizationMembershipRole(data.id, createdByUserId, "org:admin");
  return data.id;
}

async function updateOrganizationMembershipRole(
  organizationId: string,
  userId: string,
  role: "org:admin" | "org:member",
): Promise<void> {
  const response = await requestClerk(
    "update Clerk organization membership",
    `/organizations/${organizationId}/memberships/${userId}`,
    {
      method: "PATCH",
      headers: getClerkHeaders(),
      body: JSON.stringify({ role }),
    },
    { retryTransientFailures: true },
  );
  const data = await readClerkJson(
    response,
    "update Clerk organization membership",
  );
  if (!hasStringProperty(data, "role") || data.role !== role) {
    throw new Error(
      `Expected Clerk organization membership role ${role}, got ${JSON.stringify(data)}`,
    );
  }
}

export async function deleteStaleTestUsers(): Promise<void> {
  const jobRef = process.env.JOB_REF ?? "local";
  const prefix = `${jobRef}+clerk_test@e2e-browser-`;
  const searchResponse = await requestClerk(
    "list stale Clerk test users",
    `/users?query=${encodeURIComponent(`${jobRef}+clerk_test`)}&limit=100`,
    { headers: getClerkHeaders() },
    { retryTransientFailures: true },
  );
  const users = await readClerkUsers(
    searchResponse,
    "list stale Clerk test users",
  );

  for (const user of users) {
    const userEmail = user.email_addresses[0]?.email_address;
    if (userEmail?.startsWith(prefix)) {
      const deleteResponse = await requestClerk(
        "delete stale Clerk test user",
        `/users/${user.id}`,
        {
          method: "DELETE",
          headers: getClerkHeaders(),
        },
        { retryTransientFailures: true },
      );
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        console.warn(
          `Failed to delete stale user ${user.id} (${userEmail}): ${deleteResponse.status}`,
        );
      }
    }
  }
}

export async function deleteUserByEmail(email: string): Promise<void> {
  const searchResponse = await requestClerk(
    "find Clerk test user",
    `/users?query=${encodeURIComponent(email)}&limit=10`,
    { headers: getClerkHeaders() },
    { retryTransientFailures: true },
  );
  const users = await readClerkUsers(searchResponse, "find Clerk test user");

  for (const user of users) {
    const userEmail = user.email_addresses[0]?.email_address;
    if (userEmail === email) {
      const deleteResponse = await requestClerk(
        "delete Clerk test user",
        `/users/${user.id}`,
        {
          method: "DELETE",
          headers: getClerkHeaders(),
        },
        { retryTransientFailures: true },
      );
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        const responseBody = await deleteResponse.text();
        throw new Error(
          `delete Clerk test user failed with ${formatClerkResponseSummary(deleteResponse, responseBody)}`,
        );
      }
      return;
    }
  }
}

async function requestClerk(
  operation: string,
  path: string,
  init: RequestInit,
  options: ClerkRequestOptions = {},
): Promise<Response> {
  if (options.retryTransientFailures) {
    for (const delayMs of CLERK_RETRY_DELAYS_MS) {
      try {
        const response = await fetch(`${CLERK_API_BASE}${path}`, init);
        if (!isTransientClerkStatus(response.status)) {
          return response;
        }
        await response.body?.cancel();
      } catch {
        // Retry transient transport failures at this external API boundary.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  try {
    return await fetch(`${CLERK_API_BASE}${path}`, init);
  } catch (cause) {
    throw new Error(`${operation} request failed`, { cause });
  }
}

function isTransientClerkStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function readClerkJson(
  response: Response,
  operation: string,
): Promise<unknown> {
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `${operation} failed with ${formatClerkResponseSummary(response, responseBody)}`,
    );
  }

  try {
    return JSON.parse(responseBody) as unknown;
  } catch (cause) {
    throw new Error(
      `${operation} returned invalid JSON: ${formatClerkResponseSummary(response, responseBody)}`,
      {
        cause,
      },
    );
  }
}

async function readClerkUsers(
  response: Response,
  operation: string,
): Promise<readonly ClerkUserSummary[]> {
  const data = await readClerkJson(response, operation);
  if (!isClerkUserList(data)) {
    throw new Error(`${operation} returned an unexpected response`);
  }
  return data;
}

function isClerkUserList(value: unknown): value is readonly ClerkUserSummary[] {
  return (
    Array.isArray(value) &&
    value.every((user: unknown) => {
      if (!isRecord(user) || typeof user.id !== "string") {
        return false;
      }
      const emailAddresses = user.email_addresses;
      return (
        Array.isArray(emailAddresses) &&
        emailAddresses.every((emailAddress: unknown) =>
          hasStringProperty(emailAddress, "email_address"),
        )
      );
    })
  );
}

function hasStringProperty<K extends string>(
  value: unknown,
  property: K,
): value is Record<K, string> {
  return isRecord(value) && typeof value[property] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatClerkResponseSummary(
  response: Response,
  responseBody: string,
): string {
  const contentType = response.headers.get("content-type") ?? "unknown";
  const bodySummary = responseBody.replace(/\s+/g, " ").trim().slice(0, 300);
  return `HTTP ${response.status} (${contentType}): ${bodySummary || "<empty response>"}`;
}
