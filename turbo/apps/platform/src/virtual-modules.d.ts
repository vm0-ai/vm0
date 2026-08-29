declare module "virtual:mermaid" {
  const mermaid: (typeof import("mermaid"))["default"];
  export default mermaid;
}

declare module "virtual:shared-database-worker" {
  const SharedDatabaseWorker: new (options?: { name?: string }) => SharedWorker;

  export default SharedDatabaseWorker;
}
