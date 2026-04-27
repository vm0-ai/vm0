export interface TelegramConnectParams {
  telegramBotId: string;
  telegramUserId: string;
  timestamp: number;
  signature: string;
}

export interface TelegramConnectParamError {
  title: string;
  message: string;
}

type SearchParamValue = string | string[] | undefined;
type SearchParams = Record<string, SearchParamValue>;

type ParsedTelegramConnectParams =
  | { ok: true; params: TelegramConnectParams; returnPath: string }
  | { ok: false; error: TelegramConnectParamError; returnPath: string };

function firstParam(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function encodeReturnPath(params: TelegramConnectParams): string {
  const search = new URLSearchParams({
    bot: params.telegramBotId,
    tgUser: params.telegramUserId,
    ts: String(params.timestamp),
    sig: params.signature,
  });
  return `/telegram/connect?${search.toString()}`;
}

export function parseTelegramConnectParams(
  searchParams: SearchParams,
): ParsedTelegramConnectParams {
  const bot = firstParam(searchParams.bot)?.trim();
  const tgUser = firstParam(searchParams.tgUser)?.trim();
  const tsRaw = firstParam(searchParams.ts)?.trim();
  const sig = firstParam(searchParams.sig)?.trim();

  if (!bot || !tgUser || !tsRaw || !sig) {
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
    telegramUserId: tgUser,
    timestamp,
    signature: sig,
  };

  return {
    ok: true,
    params,
    returnPath: encodeReturnPath(params),
  };
}
