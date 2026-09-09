// Keep the stored/API names stable across the vm0 -> okou URL rename.
// Conflicting values remain comma-separated evidence, never a silently chosen ID.
export function normalizeGoogleAdsAttributionParams(
  input: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(input);
  for (const [canonical, alias] of [
    ["vm0_campaign_id", "okou_campaign_id"],
    ["vm0_ad_group_id", "okou_ad_group_id"],
  ] as const) {
    const values = [
      ...new Set(
        [...params.getAll(canonical), ...params.getAll(alias)]
          .map((value) => {
            return value.trim();
          })
          .filter(Boolean),
      ),
    ];
    params.delete(canonical);
    params.delete(alias);
    if (values.length > 0) {
      params.set(canonical, values.join(","));
    }
  }
  return params;
}
