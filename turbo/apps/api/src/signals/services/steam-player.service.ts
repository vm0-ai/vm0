import { command } from "ccstate";
import type { ZeroSteamPlayerResponse } from "@vm0/api-contracts/contracts/zero-steam-player";
import { connectors } from "@vm0/db/schema/connector";
import { variables } from "@vm0/db/schema/variable";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { safeJsonParse, settle } from "../utils";

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

  const responseResult = await settle(fetch(url, { signal }), signal);
  if (!responseResult.ok) {
    throw new SteamUpstreamError("Steam API request failed");
  }
  const response = responseResult.value;
  if (!response.ok) {
    throw new SteamUpstreamError(
      `Steam API request failed with HTTP ${response.status}`,
    );
  }

  const textResult = await settle(response.text(), signal);
  if (!textResult.ok) {
    throw new SteamUpstreamError("Steam API response is not valid JSON");
  }
  const body = safeJsonParse(textResult.value);
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

export const steamPlayerData$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<ZeroSteamPlayerResponse | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ steamId: variables.value })
      .from(connectors)
      .innerJoin(
        variables,
        and(
          eq(variables.orgId, connectors.orgId),
          eq(variables.userId, connectors.userId),
          eq(variables.type, "connector"),
          eq(variables.name, "STEAM_ID"),
        ),
      )
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, "steam"),
          eq(connectors.authMethod, "openid"),
          eq(connectors.needsReconnect, false),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    const steamId = row?.steamId;
    if (!steamId || !STEAM_ID_PATTERN.test(steamId)) {
      return null;
    }

    const [profile, ownedGames, recentlyPlayedGames, level, badges] =
      await Promise.all([
        fetchSteamProfile(steamId, signal),
        fetchSteamOwnedGames(steamId, signal),
        fetchSteamRecentlyPlayedGames(steamId, signal),
        fetchSteamLevel(steamId, signal),
        fetchSteamBadges(steamId, signal),
      ]);
    signal.throwIfAborted();

    return {
      steamId,
      profile,
      ownedGames,
      recentlyPlayedGames,
      level,
      badges,
    };
  },
);
