declare module "virtual:shared-database-worker" {
  const SharedDatabaseWorker: new (options?: { name?: string }) => SharedWorker;

  export default SharedDatabaseWorker;
}
