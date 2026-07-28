export interface OrgCustomConnectorField {
  readonly key: string;
  readonly label: string;
  readonly kind: "secret" | "variable";
  readonly required: boolean;
  readonly description?: string;
}

export interface OrgCustomConnectorHeaderInjection {
  readonly name: string;
  readonly valueTemplate: string;
}

export interface OrgCustomConnectorQueryInjection {
  readonly name: string;
  readonly valueTemplate: string;
}

export interface OrgCustomConnectorApiAuthMethod {
  readonly type: "api";
}

export interface OrgCustomConnectorOAuth2AuthMethod {
  readonly type: "oauth2";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly clientAuthentication: "client_secret_basic" | "client_secret_post";
}

export type OrgCustomConnectorAuthMethod =
  | OrgCustomConnectorApiAuthMethod
  | OrgCustomConnectorOAuth2AuthMethod;

export type OrgCustomConnectorPrefixes = string[];
export type OrgCustomConnectorPrefixTemplates = string[];
export type OrgCustomConnectorFields = OrgCustomConnectorField[];
export type OrgCustomConnectorHeaderInjections =
  OrgCustomConnectorHeaderInjection[];
export type OrgCustomConnectorQueryInjections =
  OrgCustomConnectorQueryInjection[];
export type OrgCustomConnectorAuthMethods = OrgCustomConnectorAuthMethod[];
