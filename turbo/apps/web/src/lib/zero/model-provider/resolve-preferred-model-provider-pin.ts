interface ModelProviderPin {
  modelProviderId: string | null;
  selectedModel: string | null;
}

interface ResolvePreferredModelProviderPinParams {
  orgId: string;
  userId: string;
  preferPersonalProvider: boolean;
  fallback: ModelProviderPin;
}

/**
 * Legacy personal-provider eager pinning is retired. Keep the helper shape so
 * chat and Slack callers can retain their existing fallback flow.
 */
export async function resolvePreferredModelProviderPin(
  params: ResolvePreferredModelProviderPinParams,
): Promise<ModelProviderPin> {
  return params.fallback;
}
