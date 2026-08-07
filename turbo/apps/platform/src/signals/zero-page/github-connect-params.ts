import { i18n } from "../../i18n/index.ts";

export interface GithubConnectParams {
  installationId: string;
  githubUserId: string;
  githubUsername?: string;
  timestamp: number;
  signature: string;
}

type GithubConnectParamErrorCode =
  | "incomplete"
  | "invalid_installation"
  | "invalid_signature"
  | "invalid_timestamp"
  | "invalid_user"
  | "invalid_username";

interface GithubConnectParamError {
  code: GithubConnectParamErrorCode;
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

function githubConnectParamError(
  code: GithubConnectParamErrorCode,
): ParsedGithubConnectParams {
  const title =
    code === "incomplete"
      ? i18n.t(($) => {
          return $.connectors.providerConnect.github.linkIncompleteTitle;
        })
      : i18n.t(($) => {
          return $.connectors.providerConnect.github.invalidTitle;
        });
  const message = (() => {
    switch (code) {
      case "incomplete": {
        return i18n.t(($) => {
          return $.connectors.providerConnect.github.linkIncomplete;
        });
      }
      case "invalid_installation": {
        return i18n.t(($) => {
          return $.connectors.providerConnect.github.invalidInstallation;
        });
      }
      case "invalid_signature": {
        return i18n.t(($) => {
          return $.connectors.providerConnect.github.invalidSignature;
        });
      }
      case "invalid_timestamp": {
        return i18n.t(($) => {
          return $.connectors.providerConnect.github.invalidTimestamp;
        });
      }
      case "invalid_user": {
        return i18n.t(($) => {
          return $.connectors.providerConnect.github.invalidUser;
        });
      }
      case "invalid_username": {
        return i18n.t(($) => {
          return $.connectors.providerConnect.github.invalidUsername;
        });
      }
    }
  })();
  return {
    ok: false,
    returnPath: "/github/connect",
    error: { code, title, message },
  };
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
    return githubConnectParamError("incomplete");
  }

  if (!/^\d+$/.test(installationId)) {
    return githubConnectParamError("invalid_installation");
  }

  if (!/^\d+$/.test(githubUserId)) {
    return githubConnectParamError("invalid_user");
  }

  if (!/^\d+$/.test(tsRaw)) {
    return githubConnectParamError("invalid_timestamp");
  }

  const timestamp = Number(tsRaw);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return githubConnectParamError("invalid_timestamp");
  }

  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return githubConnectParamError("invalid_signature");
  }

  if (githubUsername && githubUsername.length > 255) {
    return githubConnectParamError("invalid_username");
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
