const DEV_ARTIFACT_FETCH_EXACT_HOSTS = [
  "cdn.vm0.io",
  "a.okou.io",
  "cdn.okou.io",
  "cdn.vm7.io",
  "static.vm0.io",
  "static.okou.io",
] as const;
const DEV_ARTIFACT_FETCH_PARENT_DOMAINS = [
  "okou.app",
  "sites.vm0.io",
  "sites.vm7.io",
] as const;

export function isAllowedDevArtifactFetchUrl(url: URL): boolean {
  if (url.protocol !== "https:") {
    return false;
  }
  return (
    DEV_ARTIFACT_FETCH_EXACT_HOSTS.some((hostname) => {
      return url.hostname === hostname;
    }) ||
    DEV_ARTIFACT_FETCH_PARENT_DOMAINS.some((domain) => {
      return url.hostname.endsWith(`.${domain}`);
    })
  );
}
