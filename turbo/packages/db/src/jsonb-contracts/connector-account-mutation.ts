import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";

// Authorization state persists this contract across API requests. Deploy new
// readers before current clients begin writing a newly added intent value.
export type StoredConnectorAccountMutation = ConnectorAccountMutationIntent;
