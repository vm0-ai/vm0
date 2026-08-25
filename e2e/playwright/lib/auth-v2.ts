import { randomBytes } from "node:crypto";

import type {
  Page,
  Request,
  Response as PlaywrightResponse,
  Route,
} from "@playwright/test";

import {
  createOrganization,
  deleteOrganizationById,
  deleteUserByEmail,
  generateTestEmail,
} from "./clerk-api";

const DEFAULT_CLERK_API_BASE = "https://api.clerk.com/v1";
const EXPIRED_CODE_RESPONSE = {
  errors: [
    {
      code: "form_code_expired",
      long_message:
        "Verification code has expired. Request a new verification code.",
      message: "Verification code has expired.",
      meta: { param_name: "code" },
    },
  ],
} as const;

export const AUTH_V2_TEST_OTP = "424242";

export type AuthV2VerificationFlow = "sign-in" | "sign-up";
export type AuthV2VerificationAction = "attempt" | "prepare";

export interface AuthV2VerificationRequest {
  readonly action: AuthV2VerificationAction;
  readonly flow: AuthV2VerificationFlow;
}

export interface AuthV2VerificationPreparationCache {
  readonly cachedResourceCount: () => number;
  readonly dispose: () => Promise<void>;
}

export interface AuthV2PasswordIdentity {
  readonly email: string;
  readonly organizationNames: readonly string[];
  readonly password: string;
}

export interface AuthV2ResourceAdapter {
  readonly createOrganization: (
    name: string,
    userId: string,
  ) => Promise<string>;
  readonly createPasswordUser: (
    email: string,
    password: string,
  ) => Promise<string>;
  readonly deleteOrganization: (organizationId: string) => Promise<unknown>;
  readonly deleteUser: (email: string) => Promise<unknown>;
  readonly generateEmail: () => string;
}

const DEFAULT_RESOURCE_ADAPTER: AuthV2ResourceAdapter = {
  createOrganization: async (name, userId) => {
    return await createOrganization(name, userId, "playwright");
  },
  createPasswordUser: createPasswordUser,
  deleteOrganization: deleteOrganizationById,
  deleteUser: deleteUserByEmail,
  generateEmail: () => generateTestEmail("playwright"),
};

/**
 * Tracks every identity allocated by one Auth v2 test. Exact deletion runs in
 * fixture teardown; the existing generation cleanup remains the final safety
 * net when a worker or job is interrupted.
 */
export class AuthV2TestResources {
  readonly #adapter: AuthV2ResourceAdapter;
  readonly #emails: string[] = [];
  readonly #organizationIds: string[] = [];

  constructor(adapter: AuthV2ResourceAdapter = DEFAULT_RESOURCE_ADAPTER) {
    this.#adapter = adapter;
  }

  allocateEmail(): string {
    const email = this.#adapter.generateEmail();
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
    const userId = await this.#adapter.createPasswordUser(email, password);

    for (const organizationName of organizationNames) {
      const organizationId = await this.#adapter.createOrganization(
        organizationName,
        userId,
      );
      this.#organizationIds.push(organizationId);
    }

    return { email, organizationNames, password };
  }

  async cleanup(): Promise<void> {
    const cleanupErrors: Error[] = [];
    for (const organizationId of [...this.#organizationIds].reverse()) {
      try {
        await this.#adapter.deleteOrganization(organizationId);
      } catch {
        cleanupErrors.push(safeCleanupError("organization"));
      }
    }
    for (const email of [...this.#emails].reverse()) {
      try {
        await this.#adapter.deleteUser(email);
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

export function classifyAuthV2VerificationRequest(
  requestUrl: string,
  frontendApi: string,
): AuthV2VerificationRequest | null {
  let request: URL;
  let frontend: URL;
  try {
    request = new URL(requestUrl);
    frontend = clerkFrontendApiUrl(frontendApi);
  } catch {
    return null;
  }
  if (request.origin !== frontend.origin) {
    return null;
  }

  const match = request.pathname.match(
    /^\/v1\/client\/(sign_ins|sign_ups)\/[^/]+\/(prepare_first_factor|attempt_first_factor|prepare_verification|attempt_verification)\/?$/,
  );
  if (!match) {
    return null;
  }
  const isSignIn = match[1] === "sign_ins";
  const operation = match[2];
  if (
    (isSignIn && !operation.endsWith("_first_factor")) ||
    (!isSignIn && !operation.endsWith("_verification"))
  ) {
    return null;
  }
  return {
    action: operation.startsWith("prepare_") ? "prepare" : "attempt",
    flow: isSignIn ? "sign-in" : "sign-up",
  };
}

export function observeAuthV2VerificationRequests(page: Page): {
  readonly count: (
    flow: AuthV2VerificationFlow,
    action: AuthV2VerificationAction,
  ) => number;
  readonly dispose: () => void;
} {
  const frontendApi = requiredClerkFrontendApi();
  const counts = new Map<string, number>();
  const record = (request: Request): void => {
    if (request.method() !== "POST") {
      return;
    }
    const classified = classifyAuthV2VerificationRequest(
      request.url(),
      frontendApi,
    );
    if (!classified) {
      return;
    }
    const key = verificationRequestKey(classified.flow, classified.action);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  page.on("request", record);
  return {
    count: (flow, action) => {
      return counts.get(verificationRequestKey(flow, action)) ?? 0;
    },
    dispose: () => {
      page.off("request", record);
    },
  };
}

/**
 * Keeps resend and retry coverage deterministic without removing the initial
 * real Clerk preparation for each sign-in/sign-up attempt. The first successful
 * preparation response is retained in memory and replayed only to later prepare
 * requests for that exact resource path. No response data is logged or persisted.
 */
export async function cacheAuthV2VerificationPreparations(
  page: Page,
  flow: AuthV2VerificationFlow,
): Promise<AuthV2VerificationPreparationCache> {
  const frontendApi = requiredClerkFrontendApi();
  const routePattern = authV2VerificationRoutePattern(flow, "prepare");
  const responses = new Map<string, CachedVerificationPreparation>();
  const responseHandler = async (
    response: PlaywrightResponse,
  ): Promise<void> => {
    if (
      response.request().method() !== "POST" ||
      !response.ok() ||
      classifyAuthV2VerificationRequest(response.url(), frontendApi)?.flow !==
        flow
    ) {
      return;
    }
    const key = verificationPreparationResourceKey(response.url(), frontendApi);
    if (!key || responses.has(key)) {
      return;
    }
    try {
      responses.set(key, {
        body: await response.body(),
        headers: replayableResponseHeaders(response.headers()),
        status: response.status(),
      });
    } catch {
      // A disposed page can make the body unavailable. The next request then
      // falls through to Clerk instead of retaining partial response data.
    }
  };
  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    const key = verificationPreparationResourceKey(request.url(), frontendApi);
    const cached = key ? responses.get(key) : undefined;
    if (request.method() !== "POST" || !cached) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: cached.body,
      headers: cached.headers,
      status: cached.status,
    });
  };

  page.on("response", responseHandler);
  await page.route(routePattern, routeHandler);
  return {
    cachedResourceCount: () => responses.size,
    dispose: async () => {
      page.off("response", responseHandler);
      await page.unroute(routePattern, routeHandler);
      responses.clear();
    },
  };
}

export async function mockNextAuthV2VerificationExpiry(
  page: Page,
  flow: AuthV2VerificationFlow,
): Promise<void> {
  await page.route(
    authV2VerificationRoutePattern(flow, "attempt"),
    async (route) => {
      await route.fulfill({
        body: JSON.stringify(EXPIRED_CODE_RESPONSE),
        contentType: "application/json",
        status: 422,
      });
    },
    { times: 1 },
  );
}

export async function mockNextAuthV2VerificationServerError(
  page: Page,
  flow: AuthV2VerificationFlow,
): Promise<void> {
  await page.route(
    authV2VerificationRoutePattern(flow, "attempt"),
    async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          errors: [
            {
              code: "service_unavailable",
              long_message: "Authentication is temporarily unavailable.",
              message: "Authentication is temporarily unavailable.",
            },
          ],
        }),
        contentType: "application/json",
        status: 503,
      });
    },
    { times: 1 },
  );
}

function authV2VerificationRoutePattern(
  flow: AuthV2VerificationFlow,
  action: AuthV2VerificationAction,
): string {
  const frontendApi = clerkFrontendApiUrl(requiredClerkFrontendApi());
  const resource = flow === "sign-in" ? "sign_ins" : "sign_ups";
  const operation = `${action}_${
    flow === "sign-in" ? "first_factor" : "verification"
  }`;
  return `${frontendApi.origin}/v1/client/${resource}/*/${operation}*`;
}

function clerkFrontendApiUrl(frontendApi: string): URL {
  return new URL(
    frontendApi.includes("://") ? frontendApi : `https://${frontendApi}`,
  );
}

function requiredClerkFrontendApi(): string {
  const frontendApi = process.env.CLERK_FAPI;
  if (!frontendApi) {
    throw new Error("CLERK_FAPI environment variable is required");
  }
  return frontendApi;
}

function verificationRequestKey(
  flow: AuthV2VerificationFlow,
  action: AuthV2VerificationAction,
): string {
  return `${flow}:${action}`;
}

interface CachedVerificationPreparation {
  readonly body: Buffer;
  readonly headers: Record<string, string>;
  readonly status: number;
}

function verificationPreparationResourceKey(
  requestUrl: string,
  frontendApi: string,
): string | null {
  const classified = classifyAuthV2VerificationRequest(requestUrl, frontendApi);
  if (classified?.action !== "prepare") {
    return null;
  }
  return new URL(requestUrl).pathname;
}

function replayableResponseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      return ![
        "content-encoding",
        "content-length",
        "transfer-encoding",
      ].includes(name.toLowerCase());
    }),
  );
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
