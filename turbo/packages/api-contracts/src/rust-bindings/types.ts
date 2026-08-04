import type { z } from "zod";
import { buildInfoResponseSchema } from "../contracts/build-info";
import { MODEL_PROVIDER_TYPE_IDS } from "../contracts/model-provider-types";
import { SUPPORTED_RUN_MODELS } from "../contracts/model-price-tiers";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
  orgModelPoliciesResponseSchema,
  orgModelPolicySchema,
  orgModelPolicyRouteStatusSchema,
  supportedRunModelSchema,
} from "../contracts/model-providers";
import {
  artifactMissingRootPolicySchema,
  runnerZeroCliCompatibilitySchema,
  storageMountEntrySchema,
} from "../contracts/runners";
import { fileEntryWithHashSchema } from "../contracts/storages";
import {
  webhookCheckpointsContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
} from "../contracts/webhooks";
import { zeroBankingContract } from "../contracts/zero-banking";
import {
  zeroFinanceChartRequestSchema,
  zeroFinanceProfileRequestSchema,
  zeroFinanceQuoteRequestSchema,
  zeroFinanceResponseSchema,
  zeroFinanceSearchRequestSchema,
} from "../contracts/zero-finance";
import {
  zeroPeopleSearchRequestSchema,
  zeroPeopleSearchResponseSchema,
} from "../contracts/zero-people-search";
import {
  zeroScrapeRequestSchema,
  zeroScrapeResponseSchema,
} from "../contracts/zero-scrape";
import { userModelPreferenceResponseSchema } from "../contracts/zero-user-model-preference";
import {
  zeroWebSearchRequestSchema,
  zeroWebSearchResponseSchema,
} from "../contracts/zero-web-search";

export interface RustTypeBinding {
  readonly schema: z.ZodType;
  readonly rustModulePath: readonly string[];
  readonly rustTypeName: string;
  readonly direction: "request" | "response";
  readonly fieldTypeOverrides?: Readonly<Record<string, string>>;
  readonly declarations: readonly RustTypeDeclarationDoc[];
}

export interface RustTypeDeclarationDoc {
  readonly rustTypeName: string;
  readonly rustDoc: readonly string[];
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly variants?: Readonly<Record<string, readonly string[]>>;
}

export interface RustTypeModuleDoc {
  readonly rustModulePath: readonly string[];
  readonly rustDoc: readonly string[];
}

export const rustTypeRootDoc = [
  "Generated Rust DTOs for selected `@vm0/api-contracts` request and response bodies.",
  "Do not edit by hand; regenerate with `cd turbo && pnpm -F @vm0/api-contracts generate:rust`.",
  "These types preserve the TypeScript wire contract for Rust runner, native Zero CLI, and guest-agent code.",
] as const;

export const rustTypeModuleDocs = [
  {
    rustModulePath: ["build_info"],
    rustDoc: ["API build identity returned to native clients."],
  },
  {
    rustModulePath: ["models"],
    rustDoc: ["Model and model-provider discovery DTOs for native clients."],
  },
  {
    rustModulePath: ["models", "policies"],
    rustDoc: ["Workspace model routing policies visible to native clients."],
  },
  {
    rustModulePath: ["models", "preference"],
    rustDoc: ["Current user's selected model preference."],
  },
  {
    rustModulePath: ["zero"],
    rustDoc: ["Native Zero CLI request and response DTOs."],
  },
  {
    rustModulePath: ["zero", "banking"],
    rustDoc: ["Managed banking gateway DTOs for the native Zero CLI."],
  },
  {
    rustModulePath: ["zero", "finance"],
    rustDoc: ["Managed financial data DTOs for the native Zero CLI."],
  },
  {
    rustModulePath: ["zero", "people_search"],
    rustDoc: ["Managed professional search DTOs for the native Zero CLI."],
  },
  {
    rustModulePath: ["zero", "scrape"],
    rustDoc: ["Managed public page scraping DTOs for the native Zero CLI."],
  },
  {
    rustModulePath: ["zero", "web_search"],
    rustDoc: ["Managed public web search DTOs for the native Zero CLI."],
  },
  {
    rustModulePath: ["runners"],
    rustDoc: ["Runner-facing DTOs generated from TypeScript API contracts."],
  },
  {
    rustModulePath: ["runners", "storage"],
    rustDoc: [
      "Storage manifest DTOs used by runners to mount volumes and artifacts.",
    ],
  },
  {
    rustModulePath: ["runners", "zero_cli"],
    rustDoc: [
      "Bundled Zero CLI availability and build identity reported by runners.",
    ],
  },
  {
    rustModulePath: ["webhooks"],
    rustDoc: ["Webhook DTOs generated from TypeScript API contracts."],
  },
  {
    rustModulePath: ["webhooks", "agent"],
    rustDoc: ["Agent webhook DTOs exchanged between sandboxes and the API."],
  },
  {
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustDoc: ["DTOs for creating recoverable agent checkpoints."],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages"],
    rustDoc: [
      "Sandbox storage upload DTOs shared by guest agents and webhook handlers.",
    ],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustDoc: ["DTOs for committing direct sandbox storage uploads."],
  },
  {
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustDoc: ["DTOs for preparing direct sandbox storage uploads."],
  },
] satisfies readonly RustTypeModuleDoc[];

function enumVariantDocs(
  values: readonly string[],
  subject: string,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    values.map((value) => {
      return [value, [`${subject} \`${value}\`.`]];
    }),
  );
}

function scrapeResponseBranchDeclarations(
  rustTypeName: string,
  resultField: "markdown" | "links",
): readonly RustTypeDeclarationDoc[] {
  return [
    {
      rustTypeName: `${rustTypeName}Metadata`,
      rustDoc: ["Optional page metadata returned by Zero Scrape."],
      fields: {
        title: ["Optional document title."],
        description: ["Optional document description."],
        language: ["Optional detected document language."],
        statusCode: ["Optional upstream HTTP status code."],
        publishedTime: ["Optional source publication timestamp."],
      },
    },
    {
      rustTypeName: `${rustTypeName}Result`,
      rustDoc: ["Format-specific content returned by Zero Scrape."],
      fields: {
        [resultField]: [
          resultField === "markdown"
            ? "Extracted page content as Markdown."
            : "Links extracted from the page.",
        ],
      },
    },
    {
      rustTypeName,
      rustDoc: ["One billed Zero Scrape response branch."],
      fields: {
        requestedUrl: ["URL submitted to the managed scrape service."],
        finalUrl: ["Optional final URL after redirects."],
        provider: ["Managed scrape provider identifier."],
        creditsCharged: ["Workspace credits charged for this request."],
        billingQuantity: ["Provider billing quantity for this request."],
        metadata: ["Optional metadata extracted from the page."],
        format: ["Response content format."],
        mode: ["Managed scrape processing mode."],
        billingCategory: ["Billing category for the selected format and mode."],
        result: ["Format-specific scrape result."],
      },
    },
  ];
}

function scrapeResponseDeclarations(): readonly RustTypeDeclarationDoc[] {
  return [
    ...scrapeResponseBranchDeclarations("ResponseStandardMarkdown", "markdown"),
    ...scrapeResponseBranchDeclarations("ResponseEnhancedMarkdown", "markdown"),
    ...scrapeResponseBranchDeclarations("ResponseStandardLinks", "links"),
    ...scrapeResponseBranchDeclarations("ResponseEnhancedLinks", "links"),
    {
      rustTypeName: "Response",
      rustDoc: ["Strongly typed managed Zero Scrape response."],
      variants: {
        "standard.markdown": ["Standard Markdown scrape response."],
        "enhanced.markdown": ["Enhanced Markdown scrape response."],
        "standard.links": ["Standard link extraction response."],
        "enhanced.links": ["Enhanced link extraction response."],
      },
    },
  ];
}

export const rustTypeBindings = [
  {
    schema: buildInfoResponseSchema,
    rustModulePath: ["build_info"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: ["Build identity reported by the current API deployment."],
        fields: {
          commitSha: ["Optional source commit SHA for the API deployment."],
          version: ["Optional release version for the API deployment."],
        },
      },
    ],
  },
  {
    schema: supportedRunModelSchema,
    rustModulePath: ["models"],
    rustTypeName: "SupportedRunModel",
    direction: "response",
    declarations: [
      {
        rustTypeName: "SupportedRunModel",
        rustDoc: ["Canonical model identifiers accepted for new runs."],
        variants: enumVariantDocs(SUPPORTED_RUN_MODELS, "Model identifier"),
      },
    ],
  },
  {
    schema: modelProviderTypeSchema,
    rustModulePath: ["models"],
    rustTypeName: "ModelProviderType",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ModelProviderType",
        rustDoc: ["Canonical model-provider credential and runtime types."],
        variants: enumVariantDocs(
          MODEL_PROVIDER_TYPE_IDS,
          "Model-provider type",
        ),
      },
    ],
  },
  {
    schema: modelProviderCredentialScopeSchema,
    rustModulePath: ["models"],
    rustTypeName: "ModelProviderCredentialScope",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ModelProviderCredentialScope",
        rustDoc: ["Ownership scope for model-provider credentials."],
        variants: {
          org: ["Credentials owned by the organization."],
          member: ["Credentials owned by the current member."],
        },
      },
    ],
  },
  {
    schema: orgModelPolicyRouteStatusSchema,
    rustModulePath: ["models", "policies"],
    rustTypeName: "OrgModelPolicyRouteStatus",
    direction: "response",
    declarations: [
      {
        rustTypeName: "OrgModelPolicyRouteStatus",
        rustDoc: ["Resolution status for a workspace model route."],
        variants: {
          valid: ["The model route can resolve a usable provider."],
          missing_provider: ["The model route has no usable provider."],
          invalid: ["The configured model route is invalid."],
        },
      },
    ],
  },
  {
    schema: orgModelPolicySchema,
    rustModulePath: ["models", "policies"],
    rustTypeName: "Policy",
    direction: "response",
    fieldTypeOverrides: {
      model: "super::SupportedRunModel",
      defaultProviderType: "super::ModelProviderType",
      credentialScope: "super::ModelProviderCredentialScope",
      routeStatus: "OrgModelPolicyRouteStatus",
    },
    declarations: [
      {
        rustTypeName: "Policy",
        rustDoc: ["Resolved model routing policy visible to the current user."],
        fields: {
          id: ["Stable identifier for the model policy."],
          model: ["Canonical model selected by the policy."],
          modelLabel: ["Display label for the model."],
          isDefault: ["Whether this policy is the workspace default."],
          defaultProviderType: [
            "Provider type selected when no explicit provider is configured.",
          ],
          credentialScope: ["Ownership scope for the provider credentials."],
          modelProviderId: ["Optional configured model-provider identifier."],
          modelProviderSurfaceId: [
            "Optional configured model-provider surface identifier.",
          ],
          routeStatus: ["Current provider resolution status."],
          routeStatusReason: [
            "Optional explanation when the provider route is unavailable.",
          ],
          createdAt: ["Timestamp when the policy was created."],
          updatedAt: ["Timestamp when the policy was last updated."],
        },
      },
    ],
  },
  {
    schema: orgModelPoliciesResponseSchema,
    rustModulePath: ["models", "policies"],
    rustTypeName: "Response",
    direction: "response",
    fieldTypeOverrides: {
      policies: "Vec<Policy>",
      workspaceDefaultModel: "Option<super::SupportedRunModel>",
    },
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: ["Workspace model policies available to the current user."],
        fields: {
          policies: ["Resolved workspace model routing policies."],
          workspaceDefaultModel: ["Optional workspace default model."],
          workspaceDefaultPolicyId: [
            "Optional identifier for the workspace default policy.",
          ],
        },
      },
    ],
  },
  {
    schema: userModelPreferenceResponseSchema,
    rustModulePath: ["models", "preference"],
    rustTypeName: "Response",
    direction: "response",
    fieldTypeOverrides: {
      selectedModel: "Option<super::SupportedRunModel>",
    },
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: ["Current user's selected model preference."],
        fields: {
          selectedModel: ["Optional model explicitly selected by the user."],
          updatedAt: ["Optional timestamp of the last preference update."],
        },
      },
    ],
  },
  {
    schema: zeroScrapeRequestSchema,
    rustModulePath: ["zero", "scrape"],
    rustTypeName: "Request",
    direction: "request",
    declarations: [
      {
        rustTypeName: "RequestFormat",
        rustDoc: ["Requested Zero Scrape response format."],
        variants: {
          markdown: ["Return extracted Markdown content."],
          links: ["Return links extracted from the page."],
        },
      },
      {
        rustTypeName: "RequestMode",
        rustDoc: ["Managed Zero Scrape processing mode."],
        variants: {
          standard: ["Use standard page extraction."],
          enhanced: ["Use enhanced page extraction."],
        },
      },
      {
        rustTypeName: "Request",
        rustDoc: ["Request body for managed Zero Scrape."],
        fields: {
          url: ["Public HTTP or HTTPS URL to scrape."],
          format: ["Requested response format."],
          mode: ["Requested scrape processing mode."],
        },
      },
    ],
  },
  {
    schema: zeroScrapeResponseSchema,
    rustModulePath: ["zero", "scrape"],
    rustTypeName: "Response",
    direction: "response",
    declarations: scrapeResponseDeclarations(),
  },
  {
    schema: zeroPeopleSearchRequestSchema,
    rustModulePath: ["zero", "people_search"],
    rustTypeName: "Request",
    direction: "request",
    declarations: [
      {
        rustTypeName: "Request",
        rustDoc: ["Request body for managed professional search."],
        fields: {
          query: ["Natural-language professional search query."],
          limit: ["Maximum number of profiles to return."],
        },
      },
    ],
  },
  {
    schema: zeroPeopleSearchResponseSchema,
    rustModulePath: ["zero", "people_search"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ResponseProfileSource",
        rustDoc: ["Provider-backed source supporting a professional profile."],
        fields: {
          title: ["Source page title."],
          url: ["Public HTTP or HTTPS source URL."],
        },
      },
      {
        rustTypeName: "ResponseProfile",
        rustDoc: ["Professional profile extracted by the managed provider."],
        fields: {
          name: ["Professional's name."],
          title: ["Optional current role or title."],
          company: ["Optional current employer."],
          location: ["Optional reported location."],
          summary: ["Optional provider-extracted profile summary."],
          sources: ["Provider-backed sources for this profile."],
        },
      },
      {
        rustTypeName: "Response",
        rustDoc: ["Managed professional search response."],
        fields: {
          query: ["Normalized query sent to the provider."],
          limit: ["Requested result limit."],
          provider: ["Managed professional search provider identifier."],
          billingCategory: ["Billing category for the request."],
          billingQuantity: ["Provider billing quantity for the request."],
          creditsCharged: ["Workspace credits charged for the request."],
          profiles: ["Professional profiles returned by the provider."],
        },
      },
    ],
  },
  {
    schema: zeroWebSearchRequestSchema,
    rustModulePath: ["zero", "web_search"],
    rustTypeName: "Request",
    direction: "request",
    declarations: [
      {
        rustTypeName: "RequestRecency",
        rustDoc: ["Optional recency window for public web search."],
        variants: enumVariantDocs(
          ["hour", "day", "week", "month", "year"],
          "Recency window",
        ),
      },
      {
        rustTypeName: "Request",
        rustDoc: ["Request body for managed public web search."],
        fields: {
          query: ["Public web search query."],
          limit: ["Maximum number of results to return."],
          recency: ["Optional publication recency window."],
          domains: ["Optional domain allowlist for the search."],
        },
      },
    ],
  },
  {
    schema: zeroWebSearchResponseSchema,
    rustModulePath: ["zero", "web_search"],
    rustTypeName: "Response",
    direction: "response",
    fieldTypeOverrides: {
      domains: "Option<Vec<String>>",
    },
    declarations: [
      {
        rustTypeName: "ResponseRecency",
        rustDoc: ["Applied recency window for public web search."],
        variants: enumVariantDocs(
          ["hour", "day", "week", "month", "year"],
          "Recency window",
        ),
      },
      {
        rustTypeName: "ResponseResult",
        rustDoc: ["One ranked public web search result."],
        fields: {
          rank: ["One-based provider result rank."],
          title: ["Result page title."],
          url: ["Public HTTP or HTTPS result URL."],
          snippet: ["Provider-returned result snippet."],
          publishedDate: ["Optional source publication date."],
          lastUpdatedDate: ["Optional source update date."],
        },
      },
      {
        rustTypeName: "Response",
        rustDoc: ["Managed public web search response."],
        fields: {
          query: ["Normalized query sent to the provider."],
          limit: ["Requested result limit."],
          recency: ["Optional applied publication recency window."],
          domains: ["Optional applied domain allowlist."],
          provider: ["Managed web search provider identifier."],
          billingCategory: ["Billing category for the request."],
          billingQuantity: ["Provider billing quantity for the request."],
          creditsCharged: ["Workspace credits charged for the request."],
          results: ["Ranked public web search results."],
        },
      },
    ],
  },
  {
    schema: zeroFinanceSearchRequestSchema,
    rustModulePath: ["zero", "finance"],
    rustTypeName: "SearchRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "SearchRequest",
        rustDoc: ["Request body for financial instrument search."],
        fields: {
          query: ["Financial instrument search query."],
        },
      },
    ],
  },
  {
    schema: zeroFinanceProfileRequestSchema,
    rustModulePath: ["zero", "finance"],
    rustTypeName: "ProfileRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ProfileRequest",
        rustDoc: ["Request body for a company profile lookup."],
        fields: {
          symbol: ["Provider-supported financial instrument symbol."],
        },
      },
    ],
  },
  {
    schema: zeroFinanceQuoteRequestSchema,
    rustModulePath: ["zero", "finance"],
    rustTypeName: "QuoteRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "QuoteRequest",
        rustDoc: ["Request body for a market quote lookup."],
        fields: {
          symbol: ["Provider-supported financial instrument symbol."],
        },
      },
    ],
  },
  {
    schema: zeroFinanceChartRequestSchema,
    rustModulePath: ["zero", "finance"],
    rustTypeName: "ChartRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ChartRequestRange",
        rustDoc: ["Historical range requested for a market chart."],
        variants: enumVariantDocs(
          [
            "1d",
            "5d",
            "1mo",
            "3mo",
            "6mo",
            "1y",
            "2y",
            "5y",
            "10y",
            "ytd",
            "max",
          ],
          "Chart range",
        ),
      },
      {
        rustTypeName: "ChartRequestInterval",
        rustDoc: ["Sampling interval requested for a market chart."],
        variants: enumVariantDocs(
          ["1m", "2m", "5m", "15m", "30m", "60m", "1d", "1wk", "1mo"],
          "Chart interval",
        ),
      },
      {
        rustTypeName: "ChartRequest",
        rustDoc: ["Request body for market chart data."],
        fields: {
          symbol: ["Provider-supported financial instrument symbol."],
          range: ["Historical range to return."],
          interval: ["Sampling interval for chart points."],
        },
      },
    ],
  },
  {
    schema: zeroFinanceResponseSchema,
    rustModulePath: ["zero", "finance"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ResponseOperation",
        rustDoc: ["Managed financial data operation that produced a response."],
        variants: enumVariantDocs(
          ["search", "profile", "quote", "chart"],
          "Finance operation",
        ),
      },
      {
        rustTypeName: "Response",
        rustDoc: ["Managed financial data response."],
        fields: {
          operation: ["Financial data operation that produced this response."],
          provider: ["Managed financial data provider identifier."],
          billingCategory: ["Billing category for the request."],
          billingQuantity: ["Provider billing quantity for the request."],
          creditsCharged: ["Workspace credits charged for the request."],
          result: ["Opaque provider result for the selected operation."],
        },
      },
    ],
  },
  {
    schema: zeroBankingContract.accounts.body,
    rustModulePath: ["zero", "banking"],
    rustTypeName: "AccountsRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "AccountsRequest",
        rustDoc: ["Empty request body for listing managed bank accounts."],
      },
    ],
  },
  {
    schema: zeroBankingContract.accounts.responses[200],
    rustModulePath: ["zero", "banking"],
    rustTypeName: "AccountsResponse",
    direction: "response",
    declarations: [
      {
        rustTypeName: "AccountsResponseAccount",
        rustDoc: ["One bank account returned by the managed provider."],
        fields: {
          id: ["Provider account identifier."],
          name: ["Optional account display name."],
          institutionName: ["Optional financial institution name."],
          type: ["Optional provider account type."],
          last4: ["Optional last four account digits."],
          status: ["Optional provider account status."],
          currency: ["Optional account currency code."],
        },
      },
      {
        rustTypeName: "AccountsResponse",
        rustDoc: ["Managed bank account listing response."],
        fields: {
          operation: ["Banking operation that produced this response."],
          provider: ["Managed banking provider identifier."],
          accounts: ["Bank accounts returned by the provider."],
        },
      },
    ],
  },
  {
    schema: zeroBankingContract.balances.body,
    rustModulePath: ["zero", "banking"],
    rustTypeName: "BalancesRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "BalancesRequest",
        rustDoc: ["Request body for a managed bank balance lookup."],
        fields: {
          accountId: ["Provider account identifier."],
        },
      },
    ],
  },
  {
    schema: zeroBankingContract.balances.responses[200],
    rustModulePath: ["zero", "banking"],
    rustTypeName: "BalancesResponse",
    direction: "response",
    declarations: [
      {
        rustTypeName: "BalancesResponseBalance",
        rustDoc: ["Current balance information for one bank account."],
        fields: {
          accountId: ["Provider account identifier."],
          name: ["Optional account display name."],
          type: ["Optional provider account type."],
          balance: ["Optional current account balance."],
          availableBalance: ["Optional currently available balance."],
          currency: ["Optional balance currency code."],
          balanceDate: ["Optional provider balance timestamp."],
        },
      },
      {
        rustTypeName: "BalancesResponse",
        rustDoc: ["Managed bank balance response."],
        fields: {
          operation: ["Banking operation that produced this response."],
          provider: ["Managed banking provider identifier."],
          balance: ["Current account balance information."],
        },
      },
    ],
  },
  {
    schema: zeroBankingContract.transactions.body,
    rustModulePath: ["zero", "banking"],
    rustTypeName: "TransactionsRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "TransactionsRequest",
        rustDoc: ["Request body for managed bank transactions."],
        fields: {
          accountId: ["Provider account identifier."],
          from: ["Inclusive start date formatted as YYYY-MM-DD."],
          to: ["Inclusive end date formatted as YYYY-MM-DD."],
          limit: ["Maximum number of transactions to return."],
        },
      },
    ],
  },
  {
    schema: zeroBankingContract.transactions.responses[200],
    rustModulePath: ["zero", "banking"],
    rustTypeName: "TransactionsResponse",
    direction: "response",
    declarations: [
      {
        rustTypeName: "TransactionsResponseTransaction",
        rustDoc: ["One bank transaction returned by the managed provider."],
        fields: {
          id: ["Provider transaction identifier."],
          accountId: ["Provider account identifier."],
          amount: ["Optional signed transaction amount."],
          description: ["Optional transaction description."],
          memo: ["Optional transaction memo."],
          postedDate: ["Optional provider posted timestamp."],
          transactionDate: ["Optional provider transaction timestamp."],
          status: ["Optional provider transaction status."],
          categorization: ["Optional provider categorization."],
          merchant: ["Optional merchant description."],
        },
      },
      {
        rustTypeName: "TransactionsResponse",
        rustDoc: ["Managed bank transaction response."],
        fields: {
          operation: ["Banking operation that produced this response."],
          provider: ["Managed banking provider identifier."],
          accountId: ["Provider account identifier."],
          transactions: ["Transactions returned by the provider."],
        },
      },
    ],
  },
  {
    schema: runnerZeroCliCompatibilitySchema,
    rustModulePath: ["runners", "zero_cli"],
    rustTypeName: "CompatibilityDescriptor",
    direction: "request",
    declarations: [
      {
        rustTypeName: "CompatibilityDescriptor",
        rustDoc: [
          "Bundled Zero CLI availability and non-sensitive build identity reported by a runner.",
        ],
        fields: {
          available: ["Whether the runner embeds the native Zero CLI binary."],
          version: ["Optional native Zero CLI crate version."],
          buildId: ["Optional runner build containing the native CLI binary."],
          checksumSha256: [
            "Optional lowercase SHA-256 checksum of the embedded CLI bytes.",
          ],
        },
      },
    ],
  },
  {
    schema: artifactMissingRootPolicySchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "ArtifactEntryMissingRootPolicy",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ArtifactEntryMissingRootPolicy",
        rustDoc: [
          "Policy used when an artifact mount root is missing from the uploaded manifest.",
        ],
        variants: {
          fail: ["Treat a missing artifact root as an error."],
          preserveParentVersion: [
            "Preserve the parent artifact version when the root path is missing.",
          ],
        },
      },
    ],
  },
  {
    schema: storageMountEntrySchema,
    rustModulePath: ["runners", "storage"],
    rustTypeName: "StorageMountEntry",
    direction: "response",
    fieldTypeOverrides: {
      missingRootPolicy: "ArtifactEntryMissingRootPolicy",
    },
    declarations: [
      {
        rustTypeName: "StorageMountEntry",
        rustDoc: ["Canonical resolved Storage mount accepted by runners."],
        fields: {
          name: ["Storage name retained for diagnostics and cache identity."],
          storageId: ["Immutable Storage identifier."],
          versionId: ["Resolved Storage version identifier."],
          mountPath: ["Guest filesystem path where the Storage is mounted."],
          archiveUrl: [
            "Optional presigned archive URL. Explicit empty writeback mounts may omit it.",
          ],
          archiveSize: ["Optional exact encoded archive size in bytes."],
          empty: ["Whether the resolved Storage version is explicitly empty."],
          instructionsTargetFilename: [
            "Optional filename used when Storage instructions are normalized.",
          ],
          missingRootPolicy: [
            "Optional behavior when a writeback mount root is missing.",
          ],
          writeback: [
            "Whether changed contents are written back to the same Storage.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookCheckpointsContract.create.body,
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      missingRootPolicy:
        "crate::generated::types::runners::storage::ArtifactEntryMissingRootPolicy",
    },
    declarations: [
      {
        rustTypeName: "RequestArtifactSnapshot",
        rustDoc: ["Artifact version captured by an agent checkpoint."],
        fields: {
          name: ["User-facing artifact name referenced by the run."],
          version: ["Artifact version selected for the checkpoint."],
          mountPath: ["Guest filesystem path where the artifact is mounted."],
          missingRootPolicy: [
            "Optional policy retained when the artifact mount root is missing.",
          ],
        },
      },
      {
        rustTypeName: "RequestVolumeVersionsSnapshot",
        rustDoc: ["Volume versions captured by an agent checkpoint."],
        fields: {
          versions: ["Volume names mapped to their captured versions."],
        },
      },
      {
        rustTypeName: "Request",
        rustDoc: ["Request body for creating a recoverable agent checkpoint."],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          cliAgentType: ["CLI agent implementation that produced the session."],
          cliAgentSessionId: [
            "CLI agent session identifier being checkpointed.",
          ],
          cliAgentSessionHistoryHash: [
            "SHA-256 hash of the uploaded CLI agent session history.",
          ],
          artifactSnapshots: [
            "Optional artifact versions captured by the checkpoint.",
          ],
          volumeVersionsSnapshot: [
            "Optional volume versions captured by the checkpoint.",
          ],
        },
      },
    ],
  },
  {
    schema: fileEntryWithHashSchema,
    rustModulePath: ["webhooks", "agent", "storages"],
    rustTypeName: "FileEntryWithHash",
    direction: "request",
    declarations: [
      {
        rustTypeName: "FileEntryWithHash",
        rustDoc: [
          "File metadata entry used to compute and commit content-addressed storage uploads.",
        ],
        fields: {
          path: ["Path of the file inside the uploaded storage archive."],
          hash: ["SHA-256 hash of the file contents encoded as hex."],
          size: ["File size in bytes."],
        },
      },
    ],
  },
  {
    schema: webhookStoragesPrepareContract.prepare.body,
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      files: "Vec<super::FileEntryWithHash>",
    },
    declarations: [
      {
        rustTypeName: "RequestChanges",
        rustDoc: [
          "Incremental file change set sent while preparing a partial storage upload.",
        ],
        fields: {
          added: ["Paths added since the base storage version."],
          modified: ["Paths modified since the base storage version."],
          deleted: ["Paths deleted since the base storage version."],
        },
      },
      {
        rustTypeName: "Request",
        rustDoc: [
          "Request body for preparing a direct sandbox storage upload.",
        ],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          storageId: [
            "Canonical Storage identifier authorized by the agent run.",
          ],
          files: ["Content-addressed file list included in the upload."],
          parentVersionId: [
            "Optional parent version used when preparing an incremental upload.",
          ],
          force: ["Whether to bypass deduplication checks for this upload."],
          baseVersion: [
            "Optional base version identifier for an incremental upload.",
          ],
          changes: ["Optional incremental file changes from the base version."],
        },
      },
    ],
  },
  {
    schema: webhookStoragesPrepareContract.prepare.responses[200],
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ResponseUploadsArchive",
        rustDoc: ["Presigned upload target for the storage archive object."],
        fields: {
          key: ["Object key for the archive upload."],
          presignedUrl: ["Presigned URL used to upload the archive object."],
        },
      },
      {
        rustTypeName: "ResponseUploadsManifest",
        rustDoc: ["Presigned upload target for the storage manifest object."],
        fields: {
          key: ["Object key for the manifest upload."],
          presignedUrl: ["Presigned URL used to upload the manifest object."],
        },
      },
      {
        rustTypeName: "ResponseUploads",
        rustDoc: [
          "Upload targets returned when the storage version does not already exist.",
        ],
        fields: {
          archive: ["Archive upload target."],
          manifest: ["Manifest upload target."],
        },
      },
      {
        rustTypeName: "Response",
        rustDoc: [
          "Response body for preparing a direct sandbox storage upload.",
        ],
        fields: {
          versionId: ["Storage version identifier prepared for the upload."],
          existing: [
            "Whether the requested storage version already exists and can be reused.",
          ],
          uploads: [
            "Presigned upload targets when archive and manifest uploads are required.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookStoragesCommitContract.commit.body,
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Request",
    direction: "request",
    fieldTypeOverrides: {
      files: "Vec<super::FileEntryWithHash>",
    },
    declarations: [
      {
        rustTypeName: "Request",
        rustDoc: [
          "Request body for committing a direct sandbox storage upload.",
        ],
        fields: {
          runId: ["Agent run identifier bound to the sandbox token."],
          storageId: [
            "Canonical Storage identifier authorized by the agent run.",
          ],
          versionId: ["Storage version identifier being committed."],
          parentVersionId: [
            "Optional parent version used when committing an incremental upload.",
          ],
          files: [
            "Content-addressed file list included in the committed upload.",
          ],
          message: [
            "Optional commit message associated with the storage version.",
          ],
        },
      },
    ],
  },
  {
    schema: webhookStoragesCommitContract.commit.responses[200],
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustTypeName: "Response",
    direction: "response",
    declarations: [
      {
        rustTypeName: "Response",
        rustDoc: [
          "Response body returned after committing a direct sandbox storage upload.",
        ],
        fields: {
          success: ["Whether the storage commit succeeded."],
          versionId: ["Committed storage version identifier."],
          storageName: ["Storage name that was committed."],
          size: ["Total committed storage size in bytes."],
          fileCount: [
            "Number of files recorded in the committed storage version.",
          ],
          deduplicated: [
            "Whether the committed version reused existing storage content.",
          ],
        },
      },
    ],
  },
] as const satisfies readonly RustTypeBinding[];
