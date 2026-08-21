import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
  ensurePostgresDatabase,
  getPostgresDataDirectoryWhenReady,
  waitForPostgresReady,
} from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import { startOrAdoptEmbeddedPostgres } from "./embedded-postgres-startup.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type MigrationConnection = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

function adminConnectionString(port: number): string {
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
}

function databaseConnectionString(port: number): string {
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    return mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  configuredPort: number,
): Promise<MigrationConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  await prepareEmbeddedPostgresNativeRuntime();
  const logBuffer = createEmbeddedPostgresLogBuffer();

  const resolved = await startOrAdoptEmbeddedPostgres({
    dataDir,
    configuredPort,
    isPortInUse,
    probeDataDirectory: (port) => getPostgresDataDirectoryWhenReady(adminConnectionString(port)),
    isClusterInitialized: () => existsSync(path.resolve(dataDir, "PG_VERSION")),
    getRecentLogs: () => logBuffer.getRecentLogs(),
    createInstance: (port) =>
      new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "paperclip",
        password: "paperclip",
        port,
        persistent: true,
        initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
        onLog: logBuffer.append,
        onError: logBuffer.append,
      }),
    onAdopt: ({ reason }) =>
      process.emitWarning(`Reusing the embedded PostgreSQL serving ${dataDir}: ${reason}.`),
    onBusyRetry: ({ port }) =>
      process.emitWarning(
        `Embedded PostgreSQL data directory ${dataDir} is still releasing; retrying on port ${port}.`,
      ),
  }).catch((error) => {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL for ${dataDir} on port ${configuredPort}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  });

  const { port } = resolved;
  await waitForPostgresReady(adminConnectionString(port));
  await ensurePostgresDatabase(adminConnectionString(port), "paperclip");

  return {
    connectionString: databaseConnectionString(port),
    source: `embedded-postgres@${port}`,
    // Only stop what we started. An adopted cluster belongs to someone else.
    stop:
      resolved.mode === "started"
        ? async () => {
            await resolved.instance.stop();
          }
        : async () => {},
  };
}

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }

  return ensureEmbeddedPostgresConnection(target.dataDir, target.port);
}
