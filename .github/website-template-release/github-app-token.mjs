import { createSign } from "node:crypto";
import { appendFile } from "node:fs/promises";

const API_URL = "https://api.github.com";
const OWNER = "vm0-ai";
const REPOSITORY = "Template-artifact";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function parsePrivateKey(value) {
  if (value.startsWith("-----BEGIN")) {
    return value;
  }
  return Buffer.from(value, "base64").toString("utf8");
}

function createAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(privateKey, "base64url")}`;
}

async function githubRequest(path, jwt, init = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed (${response.status} ${path}): ${await response.text()}`,
    );
  }
  return response.json();
}

const appId = requiredEnv("GITHUB_APP_ID");
const privateKey = parsePrivateKey(requiredEnv("GITHUB_APP_PRIVATE_KEY"));
const outputPath = requiredEnv("GITHUB_OUTPUT");
const jwt = createAppJwt(appId, privateKey);
const installations = await githubRequest(
  "/app/installations?per_page=100",
  jwt,
);
const installation = installations.find(
  ({ account }) => account?.login?.toLowerCase() === OWNER.toLowerCase(),
);
if (!installation) {
  throw new Error(`GitHub App is not installed for ${OWNER}`);
}

const access = await githubRequest(
  `/app/installations/${installation.id}/access_tokens`,
  jwt,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repositories: [REPOSITORY],
      permissions: { contents: "read" },
    }),
  },
);
if (!access.token) {
  throw new Error("GitHub App access-token response did not include a token");
}

process.stdout.write(`::add-mask::${access.token}\n`);
await appendFile(outputPath, `token=${access.token}\n`, { encoding: "utf8" });
process.stdout.write(
  `Created a short-lived read token for ${OWNER}/${REPOSITORY}\n`,
);
