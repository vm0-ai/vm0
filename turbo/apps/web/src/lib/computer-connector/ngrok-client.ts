/**
 * ngrok REST API client for computer connector provisioning.
 *
 * Handles Bot User and Credential lifecycle for authenticated tunnel access.
 * Uses plain fetch() — no external SDK dependency.
 */
import { logger } from "../logger";

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

    const found = page.bot_users.find((u) => u.name === name);
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
