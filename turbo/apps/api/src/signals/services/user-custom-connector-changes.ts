import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";

export function changedCustomConnectorIds(
  previous: readonly AgentCustomConnectorGrant[],
  requested: readonly AgentCustomConnectorGrant[],
  operation: "replace" | "add" | "remove",
): readonly string[] {
  const before = new Map(
    previous.map((grant) => {
      return [grant.customConnectorId, new Set(grant.permissionNames)] as const;
    }),
  );
  const after =
    operation === "replace" ? new Map<string, Set<string>>() : new Map(before);
  for (const grant of requested) {
    if (operation === "remove") {
      after.delete(grant.customConnectorId);
    } else {
      after.set(grant.customConnectorId, new Set(grant.permissionNames));
    }
  }

  return [...new Set([...before.keys(), ...after.keys()])].filter((id) => {
    const oldPermissions = before.get(id);
    const newPermissions = after.get(id);
    // Membership is meaningful even when the selected permission set is empty.
    if (!oldPermissions || !newPermissions) {
      return true;
    }
    return (
      oldPermissions.size !== newPermissions.size ||
      [...oldPermissions].some((permission) => {
        return !newPermissions.has(permission);
      })
    );
  });
}
