export function rewritePreviewAppFallbackUrl(
  url: URL,
  appOrigin: string,
  onboardingOrigin: string,
): string | null {
  const rewrittenUrl = withExpectedPreviewAppOrigin(
    url,
    appOrigin,
    onboardingOrigin,
  );
  if (!rewrittenUrl) {
    return null;
  }

  rewriteNestedRedirectUrl(rewrittenUrl, appOrigin, onboardingOrigin);
  return rewrittenUrl.toString();
}

function withExpectedPreviewAppOrigin(
  url: URL,
  appOrigin: string,
  onboardingOrigin: string,
): URL | null {
  if (url.origin !== previewAppFallbackOrigin(onboardingOrigin)) {
    return null;
  }

  const appUrl = new URL(appOrigin);
  const rewrittenUrl = new URL(url.toString());
  rewrittenUrl.protocol = appUrl.protocol;
  rewrittenUrl.host = appUrl.host;
  return rewrittenUrl;
}

function previewAppFallbackOrigin(onboardingOrigin: string): string | null {
  const onboardingUrl = new URL(onboardingOrigin);
  const previewDomainMatch = /^(pr-\d+|staging)-www\.(.+)$/.exec(
    onboardingUrl.hostname,
  );
  if (!previewDomainMatch) {
    return null;
  }

  const [, previewRef, previewDomain] = previewDomainMatch;
  onboardingUrl.hostname =
    previewRef?.startsWith("pr-") && previewDomain === "omby.ai"
      ? "staging-app.vm6.ai"
      : `staging-app.${previewDomain}`;
  return onboardingUrl.origin;
}

function rewriteNestedRedirectUrl(
  url: URL,
  appOrigin: string,
  onboardingOrigin: string,
): void {
  const redirectUrl = url.searchParams.get("redirect_url");
  if (!redirectUrl) {
    return;
  }

  try {
    const rewrittenRedirectUrl = withExpectedPreviewAppOrigin(
      new URL(redirectUrl),
      appOrigin,
      onboardingOrigin,
    );
    if (rewrittenRedirectUrl) {
      url.searchParams.set("redirect_url", rewrittenRedirectUrl.toString());
    }
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
  }
}
