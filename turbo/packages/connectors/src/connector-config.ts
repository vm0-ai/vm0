import { z } from "zod";

import type { FeatureSwitchKey } from "./feature-switch-key";

/**
 * User-entered field configuration for manual connector grant methods.
 */
export interface ConnectorManualGrantFieldConfig {
  /**
   * Stable public form id used by catalog clients. This must not be a private
   * credential, storage, env binding, or runtime binding name.
   */
  publicId: string;
  label: string;
  required: boolean;
  placeholder?: string;
  /** Storage type: "secret" (default, encrypted) or "variable" (plain text). */
  storage?: "secret" | "variable";
  /**
   * Optional normalization applied to the user-entered value before it is
   * persisted.
   *
   * - `"host"`: strip the URL scheme, userinfo, path, query, fragment, and
   *   trailing slash, leaving only `host[:port]`. Use this for fields templated
   *   into a firewall base URL's authority position (`https://${{ vars.X }}`),
   *   where the firewall validator rejects values that introduce URL structure
   *   (`/`, `?`, `#`, `@`). Lets a user paste a full backend URL
   *   (e.g. `https://my-project.example.app/`) without breaking the connection.
   */
  normalize?: "host";
}

export type ConnectorAuthClientConfig =
  | {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly clientId: string;
      readonly clientSecret: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "public";
      readonly clientIdEnv: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "public";
      readonly clientId: string;
    }
  | {
      readonly clientRegistration: "dynamic";
      readonly clientType: "public";
    };

export type StaticConfidentialConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "static";
    readonly clientType: "confidential";
  }
>;

export type StaticPublicConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "static";
    readonly clientType: "public";
  }
>;

export type DynamicPublicConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "dynamic";
    readonly clientType: "public";
  }
>;

export type PublicConnectorAuthClientConfig =
  | StaticPublicConnectorAuthClientConfig
  | DynamicPublicConnectorAuthClientConfig;

export type ConnectorGrantKind =
  | "manual"
  | "auth-code"
  | "external-code"
  | "device-auth"
  | "managed";

export interface ConnectorManualGrantConfig {
  readonly kind: "manual";
  readonly fields: Record<string, ConnectorManualGrantFieldConfig>;
}

export type ConnectorAuthCodeCallbackOrigin = "web" | "api";

export interface ConnectorAuthCodeGrantConfig {
  readonly kind: "auth-code";
  readonly scopes: string[];
  readonly callbackOrigin?: ConnectorAuthCodeCallbackOrigin;
  readonly outputs: ConnectorGrantOutputBindings;
}

export interface ConnectorExternalCodeGrantConfig {
  readonly kind: "external-code";
  readonly scopes: string[];
  readonly outputs: ConnectorGrantOutputBindings;
}

export interface ConnectorDeviceAuthStartSelectOptionChoiceConfig {
  readonly value: string;
  readonly label: string;
}

type ConnectorDeviceAuthStartSelectOptionChoicesConfig = readonly [
  ConnectorDeviceAuthStartSelectOptionChoiceConfig,
  ...ConnectorDeviceAuthStartSelectOptionChoiceConfig[],
];

export interface ConnectorDeviceAuthStartSelectOptionConfig {
  readonly kind: "select";
  /**
   * Stable public start option id used by catalog clients.
   */
  readonly publicId: string;
  readonly label: string;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly options: ConnectorDeviceAuthStartSelectOptionChoicesConfig;
}

export type ConnectorDeviceAuthStartOptionConfig =
  ConnectorDeviceAuthStartSelectOptionConfig;

export type ConnectorDeviceAuthStartOptionsConfig = Readonly<
  Record<string, ConnectorDeviceAuthStartOptionConfig>
>;

export type ConnectorDeviceAuthStartOptions = Readonly<Record<string, string>>;

export interface ConnectorDeviceAuthGrantConfig {
  readonly kind: "device-auth";
  readonly scopes: string[];
  readonly outputs: ConnectorGrantOutputBindings;
  readonly startOptions?: ConnectorDeviceAuthStartOptionsConfig;
}

export interface ConnectorManagedGrantConfig {
  readonly kind: "managed";
}

export type ConnectorGrantConfig =
  | ConnectorManualGrantConfig
  | ConnectorAuthCodeGrantConfig
  | ConnectorExternalCodeGrantConfig
  | ConnectorDeviceAuthGrantConfig
  | ConnectorManagedGrantConfig;

export type ConnectorAccessKind = "static" | "refresh-token" | "none";

export const CONNECTOR_PLATFORM_SECRET_NAMES = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
] as const;
export type ConnectorPlatformSecretName =
  (typeof CONNECTOR_PLATFORM_SECRET_NAMES)[number];

export type ConnectorSecretValueRef = `$secrets.${string}`;
export type ConnectorVariableValueRef = `$vars.${string}`;
export type ConnectorOutputValueRef =
  | ConnectorSecretValueRef
  | ConnectorVariableValueRef;
export type ConnectorRefreshTokenInputValueRef =
  | ConnectorSecretValueRef
  | ConnectorVariableValueRef;
export type ConnectorEnvBindingValue =
  | ConnectorRefreshTokenInputValueRef
  | {
      readonly valueRef: ConnectorRefreshTokenInputValueRef;
      readonly optional?: boolean;
    };
export type ConnectorEnvBindings = Record<string, ConnectorEnvBindingValue>;

export type ConnectorGrantOutputBindings = Record<
  string,
  ConnectorOutputValueRef
>;
export type ConnectorRevokeInputBindings = Record<
  string,
  ConnectorSecretValueRef
>;

export interface ConnectorStorageConfig {
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

interface ConnectorEnvBindingAccessConfigBase {
  readonly envBindings: ConnectorEnvBindings;
  /**
   * `$secrets.NAME` backing sources read from platform env instead of connector
   * DB storage. Runtime aliases must still be declared in `envBindings`.
   */
  readonly platformSecrets?: readonly ConnectorPlatformSecretName[];
}

export interface ConnectorStaticAccessConfig extends ConnectorEnvBindingAccessConfigBase {
  readonly kind: "static";
}

export type ConnectorRefreshTokenInputBindings = Record<
  string,
  ConnectorRefreshTokenInputValueRef
>;
export type ConnectorRefreshTokenOutputBindings = Record<
  string,
  ConnectorOutputValueRef
>;

export interface ConnectorRefreshTokenAccessConfig extends ConnectorEnvBindingAccessConfigBase {
  readonly kind: "refresh-token";
  readonly inputs: ConnectorRefreshTokenInputBindings;
  readonly outputs: ConnectorRefreshTokenOutputBindings;
  readonly refreshableSecrets: readonly string[];
}

export interface ConnectorNoAccessConfig {
  readonly kind: "none";
}

export type ConnectorAccessConfig =
  | ConnectorStaticAccessConfig
  | ConnectorRefreshTokenAccessConfig
  | ConnectorNoAccessConfig;

export type ConnectorRevokeKind = "none" | "token-revoke";

export type ConnectorRevokeConfig =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "token-revoke";
      readonly inputs: ConnectorRevokeInputBindings;
    };

interface ConnectorAuthMethodConfigBase {
  label: string;
  helpText?: string;
  /** When false, this auth method is unavailable for new connector actions. */
  visible?: boolean;
  /** When set, this auth method is only available while the feature is enabled. */
  featureFlag?: FeatureSwitchKey;
  /** When false, feature-gated UI surfaces should not add an experimental label. */
  showExperimentalLabel?: boolean;
  /**
   * Connector-scoped storage names owned by this auth method.
   *
   * These lists are write/delete allowlists, not guarantees that rows currently
   * exist in the DB.
   */
  storage: ConnectorStorageConfig;
}

/**
 * Auth method configuration for user-selectable connector connection flows.
 */
export type ConnectorAuthMethodConfig =
  | (ConnectorAuthMethodConfigBase & {
      readonly client: ConnectorAuthClientConfig;
      readonly grant: ConnectorAuthCodeGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodConfigBase & {
      readonly client: ConnectorAuthClientConfig;
      readonly grant: ConnectorExternalCodeGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodConfigBase & {
      readonly client: PublicConnectorAuthClientConfig;
      readonly grant: ConnectorDeviceAuthGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodConfigBase & {
      readonly client?: ConnectorAuthClientConfig;
      readonly grant: ConnectorManualGrantConfig | ConnectorManagedGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    });

/**
 * Connector auth method ids exposed as configured connection flows.
 *
 * These values are connector registry keys, not lifecycle categories. Behavior
 * must be derived from the selected auth method lifecycle config.
 */
export const CONNECTOR_AUTH_METHOD_IDS = [
  "oauth",
  "api-token",
  "cli",
  "api",
] as const;
export const connectorAuthMethodIdSchema = z.enum(CONNECTOR_AUTH_METHOD_IDS);
export type ConnectorAuthMethodId = z.infer<typeof connectorAuthMethodIdSchema>;

export type ConnectorDisplayCategory =
  | "ai-general-models"
  | "ai-image-video"
  | "ai-voice-audio"
  | "ai-agent-apps"
  | "ai-memory-tracing-eval"
  | "communication-collaboration"
  | "meetings-scheduling"
  | "docs-files-knowledge"
  | "engineering-team-execution"
  | "sales-crm-business-operations"
  | "marketing-content-growth"
  | "data-automation-infrastructure";

export type ConnectorDisplayCategoryGroup = "ai";

export type ConnectorGenerationType =
  | "audio"
  | "code"
  | "document"
  | "image"
  | "presentation"
  | "text"
  | "video"
  | "website";

export const CONNECTOR_DISPLAY_CATEGORY_GROUPS: Record<
  ConnectorDisplayCategoryGroup,
  { label: string; menuLabel: string }
> = {
  ai: { label: "AI", menuLabel: "AI" },
};

export const CONNECTOR_DISPLAY_CATEGORY_META: Record<
  ConnectorDisplayCategory,
  { label: string; menuLabel: string; group?: ConnectorDisplayCategoryGroup }
> = {
  "ai-general-models": {
    label: "General Models and Reasoning",
    menuLabel: "General Models",
    group: "ai",
  },
  "ai-image-video": {
    label: "Image / Video Generation",
    menuLabel: "Image and Video",
    group: "ai",
  },
  "ai-voice-audio": {
    label: "Voice / Audio",
    menuLabel: "Voice and Audio",
    group: "ai",
  },
  "ai-agent-apps": {
    label: "Agent Platforms and AI Apps",
    menuLabel: "Agent Platforms",
    group: "ai",
  },
  "ai-memory-tracing-eval": {
    label: "Memory / Tracing / Evaluation",
    menuLabel: "Memory and Evaluation",
    group: "ai",
  },
  "communication-collaboration": {
    label: "Communication and Collaboration",
    menuLabel: "Communication",
  },
  "meetings-scheduling": {
    label: "Meetings and Scheduling",
    menuLabel: "Meetings",
  },
  "docs-files-knowledge": {
    label: "Docs, Files, and Knowledge",
    menuLabel: "Documents",
  },
  "engineering-team-execution": {
    label: "Engineering and Team Execution",
    menuLabel: "Engineering",
  },
  "sales-crm-business-operations": {
    label: "Sales, CRM, and Business Operations",
    menuLabel: "Sales and Business",
  },
  "marketing-content-growth": {
    label: "Marketing, Content, and Growth",
    menuLabel: "Marketing",
  },
  "data-automation-infrastructure": {
    label: "Data, Automation, and Infrastructure",
    menuLabel: "Data and Automation",
  },
};

export const CONNECTOR_DISPLAY_CATEGORY_ORDER: readonly ConnectorDisplayCategory[] =
  [
    "ai-general-models",
    "ai-image-video",
    "ai-voice-audio",
    "ai-agent-apps",
    "ai-memory-tracing-eval",
    "communication-collaboration",
    "meetings-scheduling",
    "docs-files-knowledge",
    "engineering-team-execution",
    "sales-crm-business-operations",
    "marketing-content-growth",
    "data-automation-infrastructure",
  ];

export interface ConnectorDisplayCategorizedItem {
  readonly category: string;
}

export interface ConnectorDisplayCategoryMetadataGroup {
  id: string;
  label: string;
  menuLabel: string;
}

export interface ConnectorDisplayCategoryMetadataCategory {
  id: string;
  label: string;
  menuLabel: string;
  groupId: string | null;
}

export interface ConnectorDisplayCategoryMetadata {
  categories: ConnectorDisplayCategoryMetadataCategory[];
  groups: ConnectorDisplayCategoryMetadataGroup[];
}

function isConnectorDisplayCategory(
  category: string,
): category is ConnectorDisplayCategory {
  return Object.prototype.hasOwnProperty.call(
    CONNECTOR_DISPLAY_CATEGORY_META,
    category,
  );
}

function fallbackCategoryLabel(category: string): string {
  const label = category
    .split(/[-_\s]+/)
    .filter((part) => {
      return part.length > 0;
    })
    .map((part) => {
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
  return label || "Other";
}

export function connectorDisplayCategoryMetadataForItems(
  items: readonly ConnectorDisplayCategorizedItem[],
): ConnectorDisplayCategoryMetadata {
  const visibleCategories = new Set(
    items.flatMap((item) => {
      return item.category ? [item.category] : [];
    }),
  );
  const orderedConnectorDisplayCategories =
    CONNECTOR_DISPLAY_CATEGORY_ORDER.filter((category) => {
      return visibleCategories.has(category);
    });
  const orderedCategoryIds = new Set<string>(orderedConnectorDisplayCategories);
  const orderedCategories = [
    ...orderedConnectorDisplayCategories,
    ...[...visibleCategories].filter((category) => {
      return !orderedCategoryIds.has(category);
    }),
  ];
  const visibleGroups = new Set<ConnectorDisplayCategoryGroup>();
  const categories = orderedCategories.map((category) => {
    if (!isConnectorDisplayCategory(category)) {
      const label = fallbackCategoryLabel(category);
      return {
        id: category,
        label,
        menuLabel: label,
        groupId: null,
      };
    }
    const metadata = CONNECTOR_DISPLAY_CATEGORY_META[category];
    if (metadata.group) {
      visibleGroups.add(metadata.group);
    }
    return {
      id: category,
      label: metadata.label,
      menuLabel: metadata.menuLabel,
      groupId: metadata.group ?? null,
    };
  });

  return {
    categories,
    groups: [...visibleGroups].map((group) => {
      const metadata = CONNECTOR_DISPLAY_CATEGORY_GROUPS[group];
      return {
        id: group,
        label: metadata.label,
        menuLabel: metadata.menuLabel,
      };
    }),
  };
}

type ConnectorAuthMethods = Partial<
  Record<ConnectorAuthMethodId, ConnectorAuthMethodConfig>
>;

type ConnectorConfigBase = {
  readonly label: string;
  readonly helpText: string;
  readonly category: ConnectorDisplayCategory;
  /**
   * Output categories this connector skill can generate. This is product
   * metadata for discovery and routing, not a permission/capability grant.
   */
  readonly generation?: readonly ConnectorGenerationType[];
  /**
   * Optional concept words and common-guess aliases used by connector search.
   * Lowercase only. Avoid duplicating content already in `label`,
   * runtime output keys, or auth method field keys.
   */
  readonly tags?: readonly string[];
};

/**
 * Base configuration shape for all connector types.
 */
export type ConnectorConfig = ConnectorConfigBase & {
  readonly authMethods: ConnectorAuthMethods;
};
