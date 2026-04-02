import { type ProviderHandler } from "../provider-types";

export const prismaPostgresHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error(
      "Prisma Postgres does not support OAuth — use API token auth",
    );
  },
  exchangeCode() {
    throw new Error(
      "Prisma Postgres does not support OAuth — use API token auth",
    );
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    return "PRISMA_POSTGRES_TOKEN";
  },
};
