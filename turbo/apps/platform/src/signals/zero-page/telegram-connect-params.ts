export interface TelegramConnectParams {
  telegramBotId: string;
  connectSignature: {
    telegramUserId: string;
    telegramUsername?: string;
    telegramDisplayName?: string;
    timestamp: number;
    signature: string;
  } | null;
}

interface TelegramConnectParamError {
  title: string;
  message: string;
}

type SearchParamValue = string | string[] | undefined;
type SearchParams = URLSearchParams | Record<string, SearchParamValue>;

type ParsedTelegramConnectParams =
  | { ok: true; params: TelegramConnectParams; returnPath: string }
  | { ok: false; error: TelegramConnectParamError; returnPath: string };

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

function encodeReturnPath(params: TelegramConnectParams): string {
  const search = new URLSearchParams({ bot: params.telegramBotId });
  if (params.connectSignature) {
    search.set("tgUser", params.connectSignature.telegramUserId);
    search.set("ts", String(params.connectSignature.timestamp));
    search.set("sig", params.connectSignature.signature);
    if (params.connectSignature.telegramUsername) {
      search.set("tgUserName", params.connectSignature.telegramUsername);
    }
    if (params.connectSignature.telegramDisplayName) {
      search.set("tgDisplayName", params.connectSignature.telegramDisplayName);
    }
  }
  return `/telegram/connect?${search.toString()}`;
}

function normalizeTelegramUsernameParam(
  value: string | undefined,
): string | undefined {
  const username = value?.trim().replace(/^@+/, "");
  return username || undefined;
}

function normalizeTelegramDisplayNameParam(
  value: string | undefined,
): string | undefined {
  const displayName = value?.trim().replace(/\s+/g, " ");
  return displayName || undefined;
}

function buildConnectSignature(params: {
  telegramUserId: string;
  telegramUsername?: string;
  telegramDisplayName?: string;
  timestamp: number;
  signature: string;
}): TelegramConnectParams["connectSignature"] {
  return {
    telegramUserId: params.telegramUserId,
    ...(params.telegramUsername
      ? { telegramUsername: params.telegramUsername }
      : {}),
    ...(params.telegramDisplayName
      ? { telegramDisplayName: params.telegramDisplayName }
      : {}),
    timestamp: params.timestamp,
    signature: params.signature,
  };
}

export function parseTelegramConnectParams(
  searchParams: SearchParams,
): ParsedTelegramConnectParams {
  const bot = firstParam(searchParams, "bot")?.trim();
  const tgUser = firstParam(searchParams, "tgUser")?.trim();
  const telegramUsername = normalizeTelegramUsernameParam(
    firstParam(searchParams, "tgUserName"),
  );
  const telegramDisplayName = normalizeTelegramDisplayNameParam(
    firstParam(searchParams, "tgDisplayName"),
  );
  const tsRaw = firstParam(searchParams, "ts")?.trim();
  const sig = firstParam(searchParams, "sig")?.trim();

  if (!bot) {
    return {
      ok: false,
      returnPath: "/telegram/connect",
      error: {
        title: "Connect link is incomplete",
        message: "Open a fresh /connect link from Telegram and try again.",
      },
    };
  }

  if (!tgUser && !tsRaw && !sig) {
    const params = { telegramBotId: bot, connectSignature: null };
    return {
      ok: true,
      params,
      returnPath: encodeReturnPath(params),
    };
  }

  if (!tgUser || !tsRaw || !sig) {
    return {
      ok: false,
      returnPath: "/telegram/connect",
      error: {
        title: "Connect link is incomplete",
        message: "Open a fresh /connect link from Telegram and try again.",
      },
    };
  }

  if (!/^\d+$/.test(tgUser)) {
    return {
      ok: false,
      returnPath: "/telegram/connect",
      error: {
        title: "Connect link is invalid",
        message: "The Telegram user on this link is not valid.",
      },
    };
  }

  if (!/^\d+$/.test(tsRaw)) {
    return {
      ok: false,
      returnPath: "/telegram/connect",
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
      returnPath: "/telegram/connect",
      error: {
        title: "Connect link is invalid",
        message: "The timestamp on this link is not valid.",
      },
    };
  }

  if (!/^[0-9a-f]{64}$/i.test(sig)) {
    return {
      ok: false,
      returnPath: "/telegram/connect",
      error: {
        title: "Connect link is invalid",
        message: "The signature on this link is not valid.",
      },
    };
  }

  if (telegramUsername && telegramUsername.length > 255) {
    return {
      ok: false,
      returnPath: "/telegram/connect",
      error: {
        title: "Connect link is invalid",
        message: "The Telegram username on this link is not valid.",
      },
    };
  }

  const params = {
    telegramBotId: bot,
    connectSignature: buildConnectSignature({
      telegramUserId: tgUser,
      telegramUsername,
      telegramDisplayName,
      timestamp,
      signature: sig,
    }),
  };

  return {
    ok: true,
    params,
    returnPath: encodeReturnPath(params),
  };
}
