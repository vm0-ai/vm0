export function matchesWorkflowNameQuery(
  workflowName: string,
  query: string,
): boolean {
  if (!query) {
    return true;
  }

  return workflowName.toLowerCase().startsWith(query.toLowerCase());
}
