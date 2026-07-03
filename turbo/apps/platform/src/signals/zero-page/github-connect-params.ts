export interface GithubConnectParams {
  installationId: string;
  githubUserId: string;
  githubUsername?: string;
  timestamp: number;
  signature: string;
}

interface GithubConnectParamError {
  title: string;
  message: string;
}

type SearchParamValue = string | string[] | undefined;
type SearchParams = URLSearchParams | Record<string, SearchParamValue>;

type ParsedGithubConnectParams =
  | { ok: true; params: GithubConnectParams; returnPath: string }
  | { ok: false; error: GithubConnectParamError; returnPath: string };

function firstParam(
  searchParams: SearchParams,
  key: string,
): string | undefined {
  if (searchParams instanceof URLSearchParams) {
    return searchParams.get(key) ?? undefined;
  }
  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeGithubUsernameParam(
  value: string | undefined,
): string | undefined {
  const username = value?.trim().replace(/^@+/, "");
  return username || undefined;
}

function encodeReturnPath(params: GithubConnectParams): string {
  const search = new URLSearchParams({
    installation: params.installationId,
    ghUser: params.githubUserId,
    ts: String(params.timestamp),
    sig: params.signature,
  });
  if (params.githubUsername) {
    search.set("ghLogin", params.githubUsername);
  }
  return `/github/connect?${search.toString()}`;
}

export function parseGithubConnectParams(
  searchParams: SearchParams,
): ParsedGithubConnectParams {
  const installationId = firstParam(searchParams, "installation")?.trim();
  const githubUserId = firstParam(searchParams, "ghUser")?.trim();
  const githubUsername = normalizeGithubUsernameParam(
    firstParam(searchParams, "ghLogin"),
  );
  const tsRaw = firstParam(searchParams, "ts")?.trim();
  const signature = firstParam(searchParams, "sig")?.trim();

  if (!installationId || !githubUserId || !tsRaw || !signature) {
    return {
      ok: false,
      returnPath: "/github/connect",
      error: {
        title: "Connect link is incomplete",
        message: "Open a fresh GitHub connect link and try again.",
      },
    };
  }

  if (!/^\d+$/.test(installationId)) {
    return {
      ok: false,
      returnPath: "/github/connect",
      error: {
        title: "Connect link is invalid",
        message: "The GitHub installation on this link is not valid.",
      },
    };
  }

  if (!/^\d+$/.test(githubUserId)) {
    return {
      ok: false,
      returnPath: "/github/connect",
      error: {
        title: "Connect link is invalid",
        message: "The GitHub user on this link is not valid.",
      },
    };
  }

  if (!/^\d+$/.test(tsRaw)) {
    return {
      ok: false,
      returnPath: "/github/connect",
      error: {
        title: "Connect link is invalid",
        message: "The timestamp on this link is not valid.",
      },
    };
  }

  const timestamp = Number(tsRaw);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return {
      ok: false,
      returnPath: "/github/connect",
      error: {
        title: "Connect link is invalid",
        message: "The timestamp on this link is not valid.",
      },
    };
  }

  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return {
      ok: false,
      returnPath: "/github/connect",
      error: {
        title: "Connect link is invalid",
        message: "The signature on this link is not valid.",
      },
    };
  }

  if (githubUsername && githubUsername.length > 255) {
    return {
      ok: false,
      returnPath: "/github/connect",
      error: {
        title: "Connect link is invalid",
        message: "The GitHub username on this link is not valid.",
      },
    };
  }

  const params = {
    installationId,
    githubUserId,
    ...(githubUsername ? { githubUsername } : {}),
    timestamp,
    signature,
  };

  return {
    ok: true,
    params,
    returnPath: encodeReturnPath(params),
  };
}
