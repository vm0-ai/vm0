import { command } from "ccstate";
import type { ZeroSteamPlayerResponse } from "@vm0/api-contracts/contracts/zero-steam-player";
import { z } from "zod";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { safeJsonParse, tapError } from "../utils";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
} from "./connector-credential-runtime.service";

class SteamUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteamUpstreamError";
  }
}

export function isSteamUpstreamError(error: unknown): boolean {
  return error instanceof SteamUpstreamError;
}

const STEAM_API_BASE_URL = "https://api.steampowered.com";
const STEAM_ID_PATTERN = /^\d{17}$/u;

const steamPlayerSummariesResponseSchema = z.object({
  response: z.object({
    players: z.array(
      z.object({
        steamid: z.string(),
        personaname: z.string().optional(),
        profileurl: z.string().optional(),
        avatarfull: z.string().optional(),
        loccountrycode: z.string().optional(),
        communityvisibilitystate: z.number().int().optional(),
      }),
    ),
  }),
});

const steamOwnedGameSchema = z.object({
  appid: z.number().int(),
  name: z.string().optional(),
  playtime_forever: z.number().int().nonnegative().default(0),
  playtime_2weeks: z.number().int().nonnegative().optional(),
  rtime_last_played: z.number().int().nonnegative().optional(),
});

const steamOwnedGamesResponseSchema = z.object({
  response: z.object({
    game_count: z.number().int().nonnegative().optional(),
    games: z.array(steamOwnedGameSchema).optional(),
  }),
});

const steamRecentlyPlayedGamesResponseSchema = z.object({
  response: z.object({
    total_count: z.number().int().nonnegative().optional(),
    games: z.array(steamOwnedGameSchema).optional(),
  }),
});

const steamLevelResponseSchema = z.object({
  response: z.object({
    player_level: z.number().int().nonnegative().optional(),
  }),
});

const steamBadgesResponseSchema = z.object({
  response: z.object({
    badges: z
      .array(
        z.object({
          badgeid: z.number().int(),
          level: z.number().int().optional(),
          completion_time: z.number().int().nonnegative().optional(),
          xp: z.number().int().optional(),
          scarcity: z.number().optional(),
        }),
      )
      .optional(),
    player_xp: z.number().int().optional(),
    player_level: z.number().int().optional(),
    player_xp_needed_to_level_up: z.number().int().optional(),
    player_xp_needed_current_level: z.number().int().optional(),
  }),
});

const steamWishlistItemSchema = z.object({
  appid: z.number().int(),
  priority: z.number().int().optional(),
  date_added: z.number().int().nonnegative().optional(),
});

const steamWishlistResponseSchema = z.object({
  response: z.object({
    items: z.array(steamWishlistItemSchema).optional(),
  }),
});

const steamWishlistItemCountResponseSchema = z.object({
  response: z.object({
    count: z.number().int().nonnegative().optional(),
  }),
});

const steamFollowedGamesResponseSchema = z.object({
  response: z.object({
    appids: z.array(z.number().int()).optional(),
  }),
});

const steamFollowedGamesCountResponseSchema = z.object({
  response: z.object({
    followed_game_count: z.number().int().nonnegative().optional(),
  }),
});

function steamApiKey(): string {
  const key = env("STEAM_WEB_API_KEY")?.trim();
  if (!key) {
    throw new Error("STEAM_WEB_API_KEY is not configured");
  }
  return key;
}

function steamTimestampToIso(timestamp: number | undefined): string | null {
  if (!timestamp) {
    return null;
  }
  return new Date(timestamp * 1000).toISOString();
}

function steamGameToResponse(
  game: z.infer<typeof steamOwnedGameSchema>,
): NonNullable<ZeroSteamPlayerResponse["ownedGames"]>["games"][number] {
  return {
    appId: game.appid,
    name: game.name ?? null,
    playtimeForeverMinutes: game.playtime_forever,
    playtimeTwoWeeksMinutes: game.playtime_2weeks ?? null,
    lastPlayedAt: steamTimestampToIso(game.rtime_last_played),
  };
}

function steamWishlistItemToResponse(
  item: z.infer<typeof steamWishlistItemSchema>,
): NonNullable<ZeroSteamPlayerResponse["wishlist"]>["items"][number] {
  return {
    appId: item.appid,
    priority: item.priority ?? null,
    addedAt: steamTimestampToIso(item.date_added),
  };
}

async function fetchSteamJson<T>(
  path: string,
  params: Readonly<Record<string, string>>,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const url = new URL(path, STEAM_API_BASE_URL);
  url.searchParams.set("key", steamApiKey());
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const response = await tapError(fetch(url, { signal }));
  signal.throwIfAborted();
  if (!response) {
    throw new SteamUpstreamError("Steam API request failed");
  }
  if (!response.ok) {
    throw new SteamUpstreamError(
      `Steam API request failed with HTTP ${response.status}`,
    );
  }

  const text = await tapError(response.text());
  signal.throwIfAborted();
  if (text === undefined) {
    throw new SteamUpstreamError("Steam API response is not valid JSON");
  }
  const body = safeJsonParse(text);
  if (body === undefined) {
    throw new SteamUpstreamError("Steam API response is not valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new SteamUpstreamError("Steam API response shape is invalid");
  }
  return parsed.data;
}

async function fetchSteamProfile(
  steamId: string,
  signal: AbortSignal,
): Promise<ZeroSteamPlayerResponse["profile"]> {
  const result = await fetchSteamJson(
    "/ISteamUser/GetPlayerSummaries/v0002/",
    { steamids: steamId },
    steamPlayerSummariesResponseSchema,
    signal,
  );
  const player = result.response.players[0];
  if (!player) {
    return null;
  }

  return {
    steamId: player.steamid,
    personaName: player.personaname ?? null,
    profileUrl: player.profileurl ?? null,
    avatarUrl: player.avatarfull ?? null,
    countryCode: player.loccountrycode ?? null,
    communityVisibilityState: player.communityvisibilitystate ?? null,
  };
}

async function fetchSteamOwnedGames(
  steamId: string,
  signal: AbortSignal,
): Promise<ZeroSteamPlayerResponse["ownedGames"]> {
  const result = await fetchSteamJson(
    "/IPlayerService/GetOwnedGames/v0001/",
    {
      steamid: steamId,
      include_appinfo: "true",
      include_played_free_games: "true",
    },
    steamOwnedGamesResponseSchema,
    signal,
  );

  const gameCount = result.response.game_count;
  const games = result.response.games;
  if (gameCount === undefined && games === undefined) {
    return null;
  }

  return {
    gameCount: gameCount ?? games?.length ?? 0,
    games: games?.map(steamGameToResponse) ?? [],
  };
}

async function fetchSteamRecentlyPlayedGames(
  steamId: string,
  signal: AbortSignal,
): Promise<ZeroSteamPlayerResponse["recentlyPlayedGames"]> {
  const result = await fetchSteamJson(
    "/IPlayerService/GetRecentlyPlayedGames/v0001/",
    { steamid: steamId },
    steamRecentlyPlayedGamesResponseSchema,
    signal,
  );

  const totalCount = result.response.total_count;
  const games = result.response.games;
  if (totalCount === undefined && games === undefined) {
    return null;
  }

  return {
    totalCount: totalCount ?? games?.length ?? 0,
    games: games?.map(steamGameToResponse) ?? [],
  };
}

async function fetchSteamLevel(
  steamId: string,
  signal: AbortSignal,
): Promise<ZeroSteamPlayerResponse["level"]> {
  const result = await fetchSteamJson(
    "/IPlayerService/GetSteamLevel/v1/",
    { steamid: steamId },
    steamLevelResponseSchema,
    signal,
  );
  return result.response.player_level ?? null;
}

async function fetchSteamBadges(
  steamId: string,
  signal: AbortSignal,
): Promise<ZeroSteamPlayerResponse["badges"]> {
  const result = await fetchSteamJson(
    "/IPlayerService/GetBadges/v1/",
    { steamid: steamId },
    steamBadgesResponseSchema,
    signal,
  );

  return {
    playerXp: result.response.player_xp ?? null,
    playerLevel: result.response.player_level ?? null,
    playerXpNeededToLevelUp:
      result.response.player_xp_needed_to_level_up ?? null,
    playerXpNeededCurrentLevel:
      result.response.player_xp_needed_current_level ?? null,
    badges:
      result.response.badges?.map((badge) => {
        return {
          badgeId: badge.badgeid,
          level: badge.level ?? null,
          completionTime: steamTimestampToIso(badge.completion_time),
          xp: badge.xp ?? null,
          scarcity: badge.scarcity ?? null,
        };
      }) ?? [],
  };
}

async function fetchSteamWishlist(
  steamId: string,
  signal: AbortSignal,
): Promise<ZeroSteamPlayerResponse["wishlist"]> {
  const [wishlist, itemCount] = await Promise.all([
    fetchSteamJson(
      "/IWishlistService/GetWishlist/v1/",
      { steamid: steamId },
      steamWishlistResponseSchema,
      signal,
    ),
    fetchSteamJson(
      "/IWishlistService/GetWishlistItemCount/v1/",
      { steamid: steamId },
      steamWishlistItemCountResponseSchema,
      signal,
    ),
  ]);

  const items = wishlist.response.items;
  const count = itemCount.response.count;
  if (items === undefined && count === undefined) {
    return null;
  }

  return {
    itemCount: count ?? items?.length ?? 0,
    items: items?.map(steamWishlistItemToResponse) ?? [],
  };
}

async function fetchSteamFollowedGames(
  steamId: string,
  signal: AbortSignal,
): Promise<ZeroSteamPlayerResponse["followedGames"]> {
  const [followedGames, followedGameCount] = await Promise.all([
    fetchSteamJson(
      "/IStoreService/GetGamesFollowed/v1/",
      { steamid: steamId },
      steamFollowedGamesResponseSchema,
      signal,
    ),
    fetchSteamJson(
      "/IStoreService/GetGamesFollowedCount/v1/",
      { steamid: steamId },
      steamFollowedGamesCountResponseSchema,
      signal,
    ),
  ]);

  const appIds = followedGames.response.appids;
  const count = followedGameCount.response.followed_game_count;
  if (appIds === undefined && count === undefined) {
    return null;
  }

  return {
    followedGameCount: count ?? appIds?.length ?? 0,
    appIds: appIds ?? [],
  };
}

export const steamPlayerData$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<ZeroSteamPlayerResponse | null> => {
    const db = get(db$);
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const loaded = await loadConnectorCredentialConnection({
      db,
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: "steam",
    });
    signal.throwIfAborted();
    if (loaded.kind !== "ok" || loaded.connection.needsReconnect) {
      return null;
    }
    const steamIdValueRef = connectorCredentialRuntimeValueRef(
      loaded.connection,
      "STEAM_ID",
    );
    if (steamIdValueRef === null) {
      return null;
    }
    const values = await loadConnectorCredentialValues({
      connection: loaded.connection,
      db,
      valueRefs: [steamIdValueRef],
    });
    signal.throwIfAborted();
    const steamId = values.get(steamIdValueRef);
    if (!steamId || !STEAM_ID_PATTERN.test(steamId)) {
      return null;
    }

    const [
      profile,
      ownedGames,
      recentlyPlayedGames,
      level,
      badges,
      wishlist,
      followedGames,
    ] = await Promise.all([
      fetchSteamProfile(steamId, signal),
      fetchSteamOwnedGames(steamId, signal),
      fetchSteamRecentlyPlayedGames(steamId, signal),
      fetchSteamLevel(steamId, signal),
      fetchSteamBadges(steamId, signal),
      fetchSteamWishlist(steamId, signal),
      fetchSteamFollowedGames(steamId, signal),
    ]);
    signal.throwIfAborted();

    return {
      steamId,
      profile,
      ownedGames,
      recentlyPlayedGames,
      level,
      badges,
      wishlist,
      followedGames,
    };
  },
);
