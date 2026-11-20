// One shared database connection for the whole app (Prisma 7 + the pg driver).
// The session runs in UTC so database times match how Prisma stores dates.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export type Db = PrismaClient;

export function createPrisma(databaseUrl: string): Db {
  const adapter = new PrismaPg({ connectionString: databaseUrl, options: "-c timezone=UTC" });
  return new PrismaClient({ adapter });
}
