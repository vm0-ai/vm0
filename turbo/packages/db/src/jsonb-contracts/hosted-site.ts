export interface HostedSiteManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly immutable?: boolean;
}

export interface HostedSiteManifest {
  readonly version: 1;
  readonly deploymentId: string;
  readonly siteId: string;
  readonly site?: string;
  readonly publicSlug: string;
  readonly deploymentVersion?: number;
  readonly createdAt: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly spaFallback: boolean;
  readonly files: Record<string, HostedSiteManifestFile>;
}
