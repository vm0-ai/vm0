# Custom MCP connector authorization

Okou supports remote MCP servers over Streamable HTTP. An organization administrator chooses one authorization setup when defining a custom MCP connector; members connect their own accounts afterward.

## Authorization setups

### Automatic (recommended)

Automatic lets Okou determine at connection time whether the MCP server requires OAuth.

- If the server requires no authentication, Okou creates a local connection without sending authentication data.
- If the server requires OAuth, Okou opens the provider's authorization page and stores the resulting member credentials in the existing connector-account boundary.

Automatic discovery runs again during reconnect, so a server that changes between no authentication and OAuth follows the newly returned result. Choosing Automatic does not grant credentials to a server that resolves to no authentication.

Okou is the only client identity published for this flow. Okou prefers Client ID Metadata Documents (CIMD) when the authorization server supports them. It falls back to Dynamic Client Registration (DCR) for compatible older servers and reuses the issuer-bound registration for the connector.

When protected-resource metadata advertises multiple authorization servers, Okou selects the first advertised issuer and binds the account to it. Changing that issuer or another validated OAuth authority boundary requires reconnecting rather than silently moving credentials.

Automatic clients support these token endpoint authentication methods:

- CIMD: public client (`none`)
- DCR: public client (`none`), `client_secret_basic`, or `client_secret_post`

Private-key JWT, OAuth Client Credentials, and enterprise-managed authorization are not supported.

### No authentication

No authentication is an explicit fixed choice. Okou connects without discovery and does not send credentials or authentication data. Use it only when the MCP server is known to require no authentication.

This differs from Automatic resolving to no authentication: the resulting local connection behaves the same, but Automatic continues to discover the server's current requirement on reconnect.

### API authentication

API authentication injects a member-provided secret into matching requests according to the connector definition. It does not use MCP OAuth discovery.

### Custom OAuth app

Custom OAuth app uses an OAuth client pre-registered by the organization. The administrator supplies the authorization URL, token URL, client ID and secret, scopes, PKCE choice, and any required authorization parameters.

Custom OAuth app supports `client_secret_basic` and `client_secret_post` at the token endpoint. Use this setup when the authorization server cannot use Automatic registration or when the organization must manage its own OAuth application.

## Accounts, reconnect, and Agent access

Each member can add and reconnect accounts through the same connector account flow. Reconnect always targets the selected account; it does not replace a sibling account. Connecting from an Agent surface grants that Agent access only after the selected account is connected.

If an Automatic OAuth account receives a valid insufficient-scope challenge during a run, the CLI provides an Okou authorization link. Complete the new consent and start a new run. The failed MCP operation is not replayed, and the current run keeps its original credential snapshot.
