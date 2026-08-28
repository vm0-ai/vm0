declare module "virtual:shared-database-worker-inline" {
  const SharedDatabaseWorker: new (options?: { name?: string }) => SharedWorker;

  export default SharedDatabaseWorker;
}
