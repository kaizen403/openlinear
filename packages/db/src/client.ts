import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { recordQueryEvent, resolveSlowQueryThresholdMs } from "./query-observer";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let cached: PrismaClient | undefined;

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  // Slow-query logging (query-observer.ts). Disabled => constructed as before.
  const slowQueryMs = resolveSlowQueryThresholdMs();
  if (slowQueryMs === null) return new PrismaClient({ adapter });
  const client = new PrismaClient({ adapter, log: [{ emit: "event", level: "query" }] });
  client.$on("query", (event) => recordQueryEvent(event.duration, event.query, slowQueryMs));
  return client;
}

function getClient(): PrismaClient {
  if (cached) return cached;
  if (globalForPrisma.prisma) {
    cached = globalForPrisma.prisma;
    return cached;
  }
  cached = createClient();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = cached;
  }
  return cached;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client as unknown as object, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as PrismaClient;

export default prisma;
