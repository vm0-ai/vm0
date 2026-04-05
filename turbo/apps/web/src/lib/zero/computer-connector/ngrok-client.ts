/**
 * ngrok REST API client for computer connector provisioning.
 *
 * Handles Bot User and Credential lifecycle for authenticated tunnel access.
 * Uses plain fetch() — no external SDK dependency.
 */
import { logger } from "../../shared/logger";

const log = logger("ngrok-client");

const NGROK_API_BASE = "https://api.ngrok.com";

interface NgrokBotUser {
  id: string;
  name: string;
}

interface NgrokBotUsersPage {
  bot_users: NgrokBotUser[];
  next_page_uri: string | null;
}

interface NgrokCredential {
  id: string;
  token: string;
}

interface NgrokEndpoint {
  id: string;
  url: string;
}

interface NgrokDomain {
  id: string;
  domain: string;
  region: string;
  cname_target: string | null;
}

/**
 * Make an authenticated request to the ngrok API.
 */
async function ngrokFetch(
  apiKey: string,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith("https://") ? path : `${NGROK_API_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Ngrok-Version": "2",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    log.error(`ngrok API error: ${response.status} ${path}`, { body });
    throw new Error(
      `ngrok API error: ${response.status} ${response.statusText}`,
    );
  }

  return response;
}

/**
 * Create a new Bot User.
 */
async function createBotUser(
  apiKey: string,
  name: string,
): Promise<NgrokBotUser> {
  const response = await ngrokFetch(apiKey, "/bot_users", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return (await response.json()) as NgrokBotUser;
}

/**
 * Find a Bot User by name. Paginates through all results.
 * Returns undefined if not found.
 */
async function findBotUserByName(
  apiKey: string,
  name: string,
): Promise<NgrokBotUser | undefined> {
  let nextPageUri: string | null = "/bot_users";

  while (nextPageUri) {
    const response = await ngrokFetch(apiKey, nextPageUri);
    const page = (await response.json()) as NgrokBotUsersPage;

    const found = page.bot_users.find((u) => {
      return u.name === name;
    });
    if (found) {
      return found;
    }

    nextPageUri = page.next_page_uri;
  }

  return undefined;
}

/**
 * Find an existing Bot User by name, or create a new one.
 */
export async function findOrCreateBotUser(
  apiKey: string,
  name: string,
): Promise<NgrokBotUser> {
  const existing = await findBotUserByName(apiKey, name);
  if (existing) {
    log.debug("Found existing ngrok bot user", { id: existing.id, name });
    return existing;
  }

  log.debug("Creating new ngrok bot user", { name });
  return createBotUser(apiKey, name);
}

/**
 * Create a Credential (authtoken) scoped to a Bot User with ACL restrictions.
 *
 * Note: The `token` field is only returned once at creation time.
 */
export async function createCredential(
  apiKey: string,
  ownerId: string,
  acl: string[],
): Promise<NgrokCredential> {
  const response = await ngrokFetch(apiKey, "/credentials", {
    method: "POST",
    body: JSON.stringify({ owner_id: ownerId, acl }),
  });
  return (await response.json()) as NgrokCredential;
}

/**
 * Delete a Credential, revoking the associated authtoken.
 */
export async function deleteCredential(
  apiKey: string,
  credentialId: string,
): Promise<void> {
  await ngrokFetch(apiKey, `/credentials/${credentialId}`, {
    method: "DELETE",
  });
}

/**
 * Create a Cloud Endpoint with a traffic policy.
 */
export async function createCloudEndpoint(
  apiKey: string,
  url: string,
  trafficPolicy: string,
): Promise<NgrokEndpoint> {
  const response = await ngrokFetch(apiKey, "/endpoints", {
    method: "POST",
    body: JSON.stringify({ url, type: "cloud", traffic_policy: trafficPolicy }),
  });
  return (await response.json()) as NgrokEndpoint;
}

/**
 * Delete a Cloud Endpoint.
 */
export async function deleteCloudEndpoint(
  apiKey: string,
  endpointId: string,
): Promise<void> {
  await ngrokFetch(apiKey, `/endpoints/${endpointId}`, {
    method: "DELETE",
  });
}

/**
 * Create a reserved domain with ngrok-assigned subdomain.
 * ngrok will automatically assign a subdomain like "abc123.ngrok-free.app"
 *
 * @param apiKey - ngrok API key
 * @param name - Desired subdomain name (e.g., "vm0-user-abc123")
 * @param region - Region (e.g., "us", "eu", "ap", "au", "sa", "jp", "in")
 * @returns The created reserved domain
 */
async function createReservedDomain(
  apiKey: string,
  name: string,
  region: string = "us",
): Promise<NgrokDomain> {
  const response = await ngrokFetch(apiKey, "/reserved_domains", {
    method: "POST",
    body: JSON.stringify({
      name, // ngrok will create: {name}.ngrok-free.app
      region,
    }),
  });

  const domain = (await response.json()) as NgrokDomain;
  log.debug("Created ngrok reserved domain", {
    id: domain.id,
    domain: domain.domain,
  });
  return domain;
}

interface NgrokReservedDomainsPage {
  reserved_domains: NgrokDomain[];
  next_page_uri: string | null;
}

/**
 * Find a reserved domain by name. Paginates through all results.
 */
async function findReservedDomainByName(
  apiKey: string,
  name: string,
): Promise<NgrokDomain | undefined> {
  let nextPageUri: string | null = "/reserved_domains";

  while (nextPageUri) {
    const response = await ngrokFetch(apiKey, nextPageUri);
    const page = (await response.json()) as NgrokReservedDomainsPage;

    const found = page.reserved_domains.find((d) => {
      return d.domain.startsWith(`${name}.`);
    });
    if (found) {
      return found;
    }

    nextPageUri = page.next_page_uri;
  }

  return undefined;
}

/**
 * Find an existing reserved domain by name, or create a new one.
 */
export async function findOrCreateReservedDomain(
  apiKey: string,
  name: string,
  region: string = "us",
): Promise<NgrokDomain> {
  const existing = await findReservedDomainByName(apiKey, name);
  if (existing) {
    log.debug("Found existing reserved domain", {
      id: existing.id,
      domain: existing.domain,
    });
    return existing;
  }

  log.debug("Creating new reserved domain", { name });
  return createReservedDomain(apiKey, name, region);
}

/**
 * Delete a reserved domain by ID.
 */
export async function deleteReservedDomain(
  apiKey: string,
  domainId: string,
): Promise<void> {
  await ngrokFetch(apiKey, `/reserved_domains/${domainId}`, {
    method: "DELETE",
  });
}

/**
 * Delete a Bot User by ID.
 */
export async function deleteBotUser(
  apiKey: string,
  botUserId: string,
): Promise<void> {
  await ngrokFetch(apiKey, `/bot_users/${botUserId}`, {
    method: "DELETE",
  });
}

/**
 * Safely delete an ngrok resource, ignoring 404 (already deleted).
 *
 * @param bestEffort - If true, log and swallow all errors (use in cleanup-on-failure paths
 *   to avoid masking the original error). If false (default), only swallow 404.
 */
export async function safeDelete(
  deleteFn: () => Promise<void>,
  resourceName: string,
  resourceId: string,
  bestEffort = false,
): Promise<void> {
  try {
    await deleteFn();
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      log.debug(`${resourceName} already deleted`, { id: resourceId });
    } else if (bestEffort) {
      log.warn(`Failed to clean up ${resourceName}`, {
        id: resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      throw error;
    }
  }
}
