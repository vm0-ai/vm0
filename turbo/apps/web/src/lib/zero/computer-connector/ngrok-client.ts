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
 * Tag property for ngrok API errors so callers can match on status code
 * without fragile string parsing.
 */
const NGROK_ERROR_TAG = Symbol("NgrokApiError");

interface NgrokApiError extends Error {
  [NGROK_ERROR_TAG]: true;
  statusCode: number;
}

function createNgrokApiError(
  statusCode: number,
  path: string,
  detail: string,
): NgrokApiError {
  const err = new Error(
    `ngrok API error: ${statusCode} ${path}: ${detail}`,
  ) as NgrokApiError;
  err[NGROK_ERROR_TAG] = true;
  err.statusCode = statusCode;
  return err;
}

/**
 * Check whether an error is an ngrok API error with a specific HTTP status code.
 */
function isNgrokError(error: unknown, statusCode: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    NGROK_ERROR_TAG in error &&
    (error as NgrokApiError).statusCode === statusCode
  );
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

    // Parse structured ngrok error for a more useful message
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { msg?: string; error_code?: string };
      if (parsed.msg) {
        detail = parsed.error_code
          ? `${parsed.error_code}: ${parsed.msg}`
          : parsed.msg;
      }
    } catch {
      // body is not JSON — use raw text
    }

    throw createNgrokApiError(response.status, path, detail);
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
 * Find a Bot User by name using ngrok's filter API.
 */
async function findBotUserByName(
  apiKey: string,
  name: string,
): Promise<NgrokBotUser | undefined> {
  const filter = encodeURIComponent(`obj.name == '${name}'`);
  const response = await ngrokFetch(apiKey, `/bot_users?filter=${filter}`);
  const page = (await response.json()) as NgrokBotUsersPage;
  return page.bot_users[0];
}

/**
 * Create a Bot User, or return the existing one if it already exists.
 * Uses optimistic create: tries POST first, falls back to lookup on 400.
 */
export async function findOrCreateBotUser(
  apiKey: string,
  name: string,
): Promise<NgrokBotUser> {
  try {
    log.debug("Creating new ngrok bot user", { name });
    return await createBotUser(apiKey, name);
  } catch (error) {
    if (!isNgrokError(error, 400)) throw error;
    log.debug("Bot user creation returned 400, looking up existing", { name });
    const existing = await findBotUserByName(apiKey, name);
    if (existing) return existing;
    throw error;
  }
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

interface NgrokEndpointsPage {
  endpoints: NgrokEndpoint[];
  next_page_uri: string | null;
}

/**
 * Find a cloud endpoint by URL. Paginates through all results.
 * Note: ngrok's /endpoints API does not support the filter parameter
 * that /reserved_domains and /bot_users support, so pagination is required.
 */
async function findEndpointByUrl(
  apiKey: string,
  url: string,
): Promise<NgrokEndpoint | undefined> {
  let nextPageUri: string | null = "/endpoints";

  while (nextPageUri) {
    const response = await ngrokFetch(apiKey, nextPageUri);
    const page = (await response.json()) as NgrokEndpointsPage;
    const found = page.endpoints.find((e) => {
      return e.url === url;
    });
    if (found) return found;
    nextPageUri = page.next_page_uri;
  }

  return undefined;
}

/**
 * Create a cloud endpoint, recovering from orphan duplicates.
 * If creation fails with 400 (URL already in use), finds and deletes the
 * orphan endpoint, then retries.
 */
export async function findOrCreateCloudEndpoint(
  apiKey: string,
  url: string,
  trafficPolicy: string,
): Promise<NgrokEndpoint> {
  try {
    return await createCloudEndpoint(apiKey, url, trafficPolicy);
  } catch (error) {
    if (!isNgrokError(error, 400)) throw error;
    log.warn("Cloud endpoint creation returned 400, cleaning up orphan", {
      url,
    });
    const existing = await findEndpointByUrl(apiKey, url);
    if (!existing) throw error;
    await deleteCloudEndpoint(apiKey, existing.id);
    return createCloudEndpoint(apiKey, url, trafficPolicy);
  }
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
 * Find a reserved domain by name using ngrok's filter API.
 */
async function findReservedDomainByName(
  apiKey: string,
  name: string,
): Promise<NgrokDomain | undefined> {
  const filter = encodeURIComponent(`obj.domain.startsWith('${name}.')`);
  const response = await ngrokFetch(
    apiKey,
    `/reserved_domains?filter=${filter}`,
  );
  const page = (await response.json()) as NgrokReservedDomainsPage;
  return page.reserved_domains[0];
}

/**
 * Create a reserved domain, or return the existing one if it already exists.
 * Uses optimistic create: tries POST first, falls back to lookup on 400.
 */
export async function findOrCreateReservedDomain(
  apiKey: string,
  name: string,
  region: string = "us",
): Promise<NgrokDomain> {
  try {
    log.debug("Creating new reserved domain", { name });
    return await createReservedDomain(apiKey, name, region);
  } catch (error) {
    if (!isNgrokError(error, 400)) throw error;
    log.debug("Reserved domain creation returned 400, looking up existing", {
      name,
    });
    const existing = await findReservedDomainByName(apiKey, name);
    if (existing) return existing;
    throw error;
  }
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
    if (isNgrokError(error, 404)) {
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
