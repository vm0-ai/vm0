export interface TelegramConnectParams {
  telegramBotId: string;
  connectSignature: {
    telegramUserId: string;
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
  }
  return `/telegram/connect?${search.toString()}`;
}

export function parseTelegramConnectParams(
  searchParams: SearchParams,
): ParsedTelegramConnectParams {
  const bot = firstParam(searchParams, "bot")?.trim();
  const tgUser = firstParam(searchParams, "tgUser")?.trim();
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

  const params = {
    telegramBotId: bot,
    connectSignature: {
      telegramUserId: tgUser,
      timestamp,
      signature: sig,
    },
  };

  return {
    ok: true,
    params,
    returnPath: encodeReturnPath(params),
  };
}
