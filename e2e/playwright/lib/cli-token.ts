import type { ApiPreviewHeaders } from "./api-preview-auth";

export interface CliTokenOptions {
  readonly apiPreviewHeaders?: ApiPreviewHeaders;
  readonly apiUrl: string;
  readonly clerkSessionToken: string;
}

export async function issueCliToken(options: CliTokenOptions): Promise<string> {
  const commonHeaders = new Headers({ "Content-Type": "application/json" });
  for (const [name, value] of Object.entries(options.apiPreviewHeaders ?? {})) {
    if (value) {
      commonHeaders.set(name, value);
    }
  }

  const device = await postJson(
    "create CLI device authorization",
    new URL("/api/cli/auth/device", options.apiUrl),
    commonHeaders,
    {},
  );
  const deviceCode = readStringProperty(
    device,
    "device_code",
    "CLI device authorization",
  );

  const approveHeaders = new Headers(commonHeaders);
  approveHeaders.set("Authorization", `Bearer ${options.clerkSessionToken}`);
  await postJson(
    "approve CLI device authorization",
    new URL("/api/cli/auth/approve", options.apiUrl),
    approveHeaders,
    { device_code: deviceCode },
  );

  const credential = await postJson(
    "exchange CLI device authorization",
    new URL("/api/cli/auth/token", options.apiUrl),
    commonHeaders,
    { device_code: deviceCode },
  );
  return readStringProperty(credential, "access_token", "CLI token exchange");
}

async function postJson(
  operation: string,
  url: URL,
  headers: Headers,
  body: object,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${operation} failed with HTTP ${response.status}`);
  }

  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw new Error(`${operation} returned invalid JSON`, { cause });
  }
}

function readStringProperty(
  value: unknown,
  property: string,
  operation: string,
): string {
  if (!isRecord(value)) {
    throw new Error(`${operation} returned no ${property}`);
  }
  const propertyValue = value[property];
  if (typeof propertyValue !== "string" || propertyValue.length === 0) {
    throw new Error(`${operation} returned no ${property}`);
  }
  return propertyValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
