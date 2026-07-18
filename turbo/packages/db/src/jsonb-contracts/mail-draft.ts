/**
 * Opaque v1 payload retained only while old API pods can overlap the v2
 * Gmail-resource deployment. New application code must not read or write it.
 */
export type LegacyMailDraftData = Record<string, unknown>;
