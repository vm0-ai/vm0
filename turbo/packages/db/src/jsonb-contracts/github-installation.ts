export interface GitHubMemoryTrustedContributorConfig {
  readonly githubUserId?: string;
  readonly login?: string;
  readonly email?: string;
}

export interface GitHubMemoryRepositoryConfig {
  readonly id?: number;
  readonly name?: string;
  readonly fullName: string;
  readonly defaultBranch?: string | null;
  readonly selected: boolean;
  readonly includeIssues?: boolean;
  readonly includePullRequests?: boolean;
  readonly includeComments?: boolean;
  readonly trustedContributors: readonly GitHubMemoryTrustedContributorConfig[];
}

export interface GitHubMemoryUserConfig {
  readonly repositories: readonly GitHubMemoryRepositoryConfig[];
  readonly updatedAt?: string;
}

export interface GitHubInstallationRepoConfigs {
  readonly memory?: {
    readonly users?: Record<string, GitHubMemoryUserConfig>;
  };
}
