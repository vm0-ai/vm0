/**
 * GitHub App authentication utilities.
 *
 * Generates JWTs signed with the App's private key and exchanges them
 * for short-lived installation access tokens via the GitHub API.
 */

import { createSign } from "node:crypto";

/**
 * Create a JWT for authenticating as a GitHub App.
 *
 * The JWT is signed with RS256 using the App's private key and is valid
 * for 10 minutes (GitHub's maximum).
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
function createAppJWT(appId: string, privateKeyBase64: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // Issued 60s ago to allow clock drift
    exp: now + 600, // Expires in 10 minutes
    iss: appId,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const privateKey = Buffer.from(privateKeyBase64, "base64").toString("utf-8");
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Get an installation access token for a GitHub App installation.
 *
 * Uses the App JWT to authenticate and request a short-lived token
 * (expires in ~1 hour) scoped to the specific installation.
 *
 * @see https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
 */
export async function getInstallationAccessToken(
  appId: string,
  privateKeyBase64: string,
  installationId: string,
): Promise<{ token: string; expiresAt: string }> {
  const jwt = createAppJWT(appId, privateKeyBase64);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to get installation access token: ${res.status} ${body}`,
    );
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

/**
 * Get installation details from the GitHub API.
 *
 * Uses the App JWT to fetch the installation's account info
 * (target type, ID, and display name).
 */
export async function getInstallationInfo(
  appId: string,
  privateKeyBase64: string,
  installationId: string,
): Promise<{
  targetType: string;
  targetId: string;
  targetName: string;
}> {
  const jwt = createAppJWT(appId, privateKeyBase64);

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get installation info: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    account: { id: number; login: string; type: string };
  };

  return {
    targetType: data.account.type,
    targetId: String(data.account.id),
    targetName: data.account.login,
  };
}

function base64url(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
