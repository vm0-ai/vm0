import type { JsonValue } from "./shared";

/**
 * Compatibility-only contract for the physical `insights_daily` table retained
 * by #26154. The old API can remain behind the migrated database for up to the
 * observed ~102-minute DB/API rollout window. Remove with #26170 after the
 * preceding API release and its rollback/drain window have closed.
 */
export type InsightsDailyData = JsonValue;
