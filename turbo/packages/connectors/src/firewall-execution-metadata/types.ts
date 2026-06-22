export interface FirewallExecutionBaseUrlTemplateMetadata {
  readonly base: string;
  readonly credentialed: boolean;
}

export interface FirewallExecutionMetadataSummary {
  readonly type: string;
  readonly billable: boolean;
}

export interface FirewallExecutionMetadataDetail extends FirewallExecutionMetadataSummary {
  readonly baseUrlVarNames: readonly string[];
  readonly baseUrlTemplates: readonly FirewallExecutionBaseUrlTemplateMetadata[];
  readonly secretPlaceholderNames: readonly string[];
  readonly placeholderValues: Readonly<Record<string, string>>;
}
