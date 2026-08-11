import { randomBytes } from "node:crypto";

const DEFAULT_CLERK_API_BASE = "https://api.clerk.com/v1";
const CLERK_RETRY_DELAYS_MS = [500, 1_500] as const;
const CLERK_MAX_RETRY_AFTER_MS = 2_000;

interface ClerkEmailAddress {
  readonly email_address: string;
}

interface ClerkUserSummary {
  readonly id: string;
  readonly email_addresses: readonly ClerkEmailAddress[];
}

interface RetryableClerkRequestInit extends RequestInit {
  readonly method: "GET" | "DELETE" | "PATCH";
}

export interface RunnerTestAccounts {
  readonly runner: string;
  readonly codex: string;
  readonly claude: string;
}

function getClerkApiBase(): string {
  const testApiBase = process.env.CLERK_API_TEST_BASE_URL;
  if (!testApiBase) {
    return DEFAULT_CLERK_API_BASE;
  }

  const testApiUrl = new URL(testApiBase);
  if (testApiUrl.protocol !== "http:" || testApiUrl.hostname !== "127.0.0.1") {
    throw new Error("CLERK_API_TEST_BASE_URL must use an HTTP 127.0.0.1 URL");
  }
  return testApiBase;
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

export function runnerTestAccounts(): RunnerTestAccounts {
  const jobRef = process.env.JOB_REF ?? "local";
  return {
    runner: `${jobRef}+clerk_test+runner@vm0-e2e.ai`,
    codex: `${jobRef}+clerk_test+runner-real-codex@vm0-e2e.ai`,
    claude: `${jobRef}+clerk_test+runner-real-claude@vm0-e2e.ai`,
  };
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
    throw new Error(
      `create Clerk user returned an unexpected response: ${formatClerkResponseSummary(response)}`,
    );
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
      `create Clerk organization returned an unexpected response: ${formatClerkResponseSummary(response)}`,
    );
  }
  await updateOrganizationMembershipRole(data.id, createdByUserId, "org:admin");
  return data.id;
}

export async function createOrganizationMembership(
  organizationId: string,
  userId: string,
): Promise<void> {
  const response = await requestClerk(
    "create Clerk organization membership",
    `/organizations/${organizationId}/memberships`,
    {
      method: "POST",
      headers: getClerkHeaders(),
      body: JSON.stringify({ user_id: userId, role: "org:member" }),
    },
  );
  const data = await readClerkJson(
    response,
    "create Clerk organization membership",
  );
  if (!hasStringProperty(data, "role") || data.role !== "org:member") {
    throw new Error(
      `create Clerk organization membership returned an unexpected role: ${formatClerkResponseSummary(response)}`,
    );
  }
}

async function updateOrganizationMembershipRole(
  organizationId: string,
  userId: string,
  role: "org:admin" | "org:member",
): Promise<void> {
  const response = await requestClerkWithRetry(
    "update Clerk organization membership",
    `/organizations/${organizationId}/memberships/${userId}`,
    {
      method: "PATCH",
      headers: getClerkHeaders(),
      body: JSON.stringify({ role }),
    },
  );
  const data = await readClerkJson(
    response,
    "update Clerk organization membership",
  );
  if (!hasStringProperty(data, "role") || data.role !== role) {
    throw new Error(
      `update Clerk organization membership returned an unexpected role: ${formatClerkResponseSummary(response)}`,
    );
  }
}

export async function deleteStaleTestUsers(): Promise<void> {
  const jobRef = process.env.JOB_REF ?? "local";
  const prefix = `${jobRef}+clerk_test@e2e-browser-`;
  let users: readonly ClerkUserSummary[];
  try {
    const searchResponse = await requestClerkWithRetry(
      "list stale Clerk test users",
      `/users?query=${encodeURIComponent(`${jobRef}+clerk_test`)}&limit=100`,
      { method: "GET", headers: getClerkHeaders() },
    );
    users = await readClerkUsers(searchResponse, "list stale Clerk test users");
  } catch {
    console.warn(
      "Failed to list stale Clerk test users; continuing without stale cleanup",
    );
    return;
  }

  for (const user of users) {
    const userEmail = user.email_addresses[0]?.email_address;
    if (!userEmail?.startsWith(prefix)) {
      continue;
    }

    try {
      const deleteResponse = await requestClerk(
        "delete stale Clerk test user",
        `/users/${user.id}`,
        { method: "DELETE", headers: getClerkHeaders() },
      );
      await deleteResponse.body?.cancel();
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        console.warn(
          `Failed to delete a stale Clerk test user with ${formatClerkResponseSummary(deleteResponse)}`,
        );
      }
    } catch {
      console.warn(
        "Failed to delete a stale Clerk test user; continuing stale cleanup",
      );
    }
  }
}

export async function deleteOrganizationById(
  organizationId: string,
): Promise<void> {
  const response = await requestClerkWithRetry(
    "delete Clerk test organization",
    `/organizations/${organizationId}`,
    { method: "DELETE", headers: getClerkHeaders() },
  );
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `delete Clerk test organization failed with ${formatClerkResponseSummary(response)}`,
    );
  }
}

export async function deleteUserByEmail(email: string): Promise<void> {
  const searchResponse = await requestClerkWithRetry(
    "find Clerk test user",
    `/users?query=${encodeURIComponent(email)}&limit=10`,
    { method: "GET", headers: getClerkHeaders() },
  );
  const users = await readClerkUsers(searchResponse, "find Clerk test user");

  for (const user of users) {
    const userEmail = user.email_addresses[0]?.email_address;
    if (userEmail !== email) {
      continue;
    }

    const deleteResponse = await requestClerkWithRetry(
      "delete Clerk test user",
      `/users/${user.id}`,
      { method: "DELETE", headers: getClerkHeaders() },
    );
    await deleteResponse.body?.cancel();
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      throw new Error(
        `delete Clerk test user failed with ${formatClerkResponseSummary(deleteResponse)}`,
      );
    }
    return;
  }
}

async function requestClerk(
  operation: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${getClerkApiBase()}${path}`;
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw new Error(`${operation} request failed`, { cause });
  }
}

async function requestClerkWithRetry(
  operation: string,
  path: string,
  init: RetryableClerkRequestInit,
): Promise<Response> {
  const url = `${getClerkApiBase()}${path}`;
  for (const fallbackDelayMs of CLERK_RETRY_DELAYS_MS) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch {
      await wait(fallbackDelayMs);
      continue;
    }

    if (!isTransientClerkStatus(response.status)) {
      return response;
    }

    const delayMs = clerkRetryDelayMs(response, fallbackDelayMs);
    if (delayMs === null) {
      return response;
    }
    await response.body?.cancel();
    await wait(delayMs);
  }

  return await requestClerk(operation, path, init);
}

function isTransientClerkStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function clerkRetryDelayMs(
  response: Response,
  fallbackDelayMs: number,
): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return fallbackDelayMs;
  }

  const retryAfterSeconds = Number(retryAfter);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
    return fallbackDelayMs;
  }

  const retryAfterMs = Math.ceil(retryAfterSeconds * 1_000);
  return retryAfterMs <= CLERK_MAX_RETRY_AFTER_MS ? retryAfterMs : null;
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function readClerkJson(
  response: Response,
  operation: string,
): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `${operation} failed with ${formatClerkResponseSummary(response)}`,
    );
  }

  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch (cause) {
    throw new Error(`${operation} response read failed`, { cause });
  }

  try {
    const data: unknown = JSON.parse(responseBody);
    return data;
  } catch {
    throw new Error(
      `${operation} returned invalid JSON: ${formatClerkResponseSummary(response)}`,
    );
  }
}

async function readClerkUsers(
  response: Response,
  operation: string,
): Promise<readonly ClerkUserSummary[]> {
  const data = await readClerkJson(response, operation);
  if (!isClerkUserList(data)) {
    throw new Error(
      `${operation} returned an unexpected response: ${formatClerkResponseSummary(response)}`,
    );
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

function formatClerkResponseSummary(response: Response): string {
  return `HTTP ${response.status} (${classifyClerkResponse(response)})`;
}

function classifyClerkResponse(
  response: Response,
): "json" | "html" | "other" | "unknown" {
  const contentType = response.headers.get("content-type");
  if (!contentType) {
    return "unknown";
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    return "json";
  }
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return "html";
  }
  return "other";
}
