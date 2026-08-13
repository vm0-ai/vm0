import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const steamPlayerProfileSchema = z.object({
  steamId: z.string(),
  personaName: z.string().nullable(),
  profileUrl: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  countryCode: z.string().nullable(),
  communityVisibilityState: z.number().int().nullable(),
});

export const steamPlayerGameSchema = z.object({
  appId: z.number().int(),
  name: z.string().nullable(),
  playtimeForeverMinutes: z.number().int().nonnegative(),
  playtimeTwoWeeksMinutes: z.number().int().nonnegative().nullable(),
  lastPlayedAt: z.string().nullable(),
});

export const steamPlayerOwnedGamesSchema = z.object({
  gameCount: z.number().int().nonnegative(),
  games: z.array(steamPlayerGameSchema),
});

export const steamPlayerRecentlyPlayedGamesSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  games: z.array(steamPlayerGameSchema),
});

export const steamPlayerBadgeSchema = z.object({
  badgeId: z.number().int(),
  level: z.number().int().nullable(),
  completionTime: z.string().nullable(),
  xp: z.number().int().nullable(),
  scarcity: z.number().nullable(),
});

export const steamPlayerBadgesSchema = z.object({
  playerXp: z.number().int().nullable(),
  playerLevel: z.number().int().nullable(),
  playerXpNeededToLevelUp: z.number().int().nullable(),
  playerXpNeededCurrentLevel: z.number().int().nullable(),
  badges: z.array(steamPlayerBadgeSchema),
});

export const steamPlayerWishlistItemSchema = z.object({
  appId: z.number().int(),
  priority: z.number().int().nullable(),
  addedAt: z.string().nullable(),
});

export const steamPlayerWishlistSchema = z.object({
  itemCount: z.number().int().nonnegative(),
  items: z.array(steamPlayerWishlistItemSchema),
});

export const steamPlayerFollowedGamesSchema = z.object({
  followedGameCount: z.number().int().nonnegative(),
  appIds: z.array(z.number().int()),
});

export const steamPlayerResponseSchema = z.object({
  steamId: z.string(),
  profile: steamPlayerProfileSchema.nullable(),
  ownedGames: steamPlayerOwnedGamesSchema.nullable(),
  recentlyPlayedGames: steamPlayerRecentlyPlayedGamesSchema.nullable(),
  level: z.number().int().nullable(),
  badges: steamPlayerBadgesSchema.nullable(),
  wishlist: steamPlayerWishlistSchema.nullable(),
  followedGames: steamPlayerFollowedGamesSchema.nullable(),
});

export type SteamPlayerResponse = z.infer<typeof steamPlayerResponseSchema>;

export const steamPlayerContract = c.router({
  getPlayer: {
    method: "GET",
    path: "/api/okou/connectors/steam/player",
    headers: authHeadersSchema,
    responses: {
      200: steamPlayerResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Read connected Steam player profile, library, playtime, wishlist, and followed games data",
  },
});
