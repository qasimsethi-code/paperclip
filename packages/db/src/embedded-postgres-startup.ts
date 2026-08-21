import path from "node:path";
import {
  POSTMASTER_LOCK_FILE_NAME,
  inspectPostmasterLock,
  removeStalePostmasterLock,
} from "./embedded-postgres-lock.js";

/**
 * What to do about the cluster for one data directory.
 *
 * There is no "start on a different port" outcome, and that is the point. The
 * data directory — not the port — is the resource a postmaster owns
 * exclusively. Moving to a free port does nothing to make a second postmaster
 * over the same files safe; PostgreSQL still refuses with `pre-existing shared
 * memory block is still in use`. So either we attach to the cluster that owns
 * the directory, or we start ours on the configured port, or we fail loudly.
 */
export type EmbeddedPostgresPlan =
  | { action: "adopt"; port: number; reason: string }
  | { action: "start"; port: number; removedStaleLock: boolean };

export type PlanEmbeddedPostgresStartupOptions = {
  dataDir: string;
  configuredPort: number;
  /** Budget for waiting out a teardown race. Defaults to 60s. */
  timeoutMs?: number;
  /** Data directory a *ready* server on `port` reports, or null if none is. */
  probeDataDirectory: (port: number) => Promise<string | null>;
  isPortInUse: (port: number) => Promise<boolean>;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWait?: (info: { reason: string; elapsedMs: number }) => void;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * PostgreSQL's own words for "this data directory is still owned". A restart
 * that kills a postmaster leaves its shared memory mapped and its socket in
 * teardown for a short window, so these are transient, not fatal.
 */
export function isDataDirectoryBusyError(recentLogs: readonly string[]): boolean {
  const haystack = recentLogs.join("\n").toLowerCase();
  return (
    haystack.includes("pre-existing shared memory block is still in use") ||
    haystack.includes("another server might be running") ||
    (haystack.includes("lock file") && haystack.includes("already exists"))
  );
}

export async function planEmbeddedPostgresStartup(
  options: PlanEmbeddedPostgresStartupOptions,
): Promise<EmbeddedPostgresPlan> {
  const { dataDir, configuredPort, probeDataDirectory, isPortInUse } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const ownsDataDir = (actual: string | null) =>
    typeof actual === "string" && path.resolve(actual) === path.resolve(dataDir);

  let removedStaleLock = false;

  for (;;) {
    const lockStatus = inspectPostmasterLock(dataDir);

    if (lockStatus.status === "running") {
      const port = lockStatus.lock.port ?? configuredPort;
      return {
        action: "adopt",
        port,
        reason: `postmaster pid ${lockStatus.lock.pid} is running on port ${port}`,
      };
    }

    if (lockStatus.status === "indeterminate") {
      const port = lockStatus.lock.port ?? configuredPort;
      if (ownsDataDir(await probeDataDirectory(port))) {
        return { action: "adopt", port, reason: `the server on port ${port} serves this data directory` };
      }
      if (elapsed() >= timeoutMs) {
        throw new Error(
          `Embedded PostgreSQL data directory ${dataDir} holds a ${POSTMASTER_LOCK_FILE_NAME} that cannot be ` +
            `adjudicated (${lockStatus.reason}), and no server answered on port ${port} within ${timeoutMs}ms. ` +
            `Refusing to start a second postmaster over live data. Stop any PostgreSQL still using this ` +
            `directory, then retry.`,
        );
      }
      options.onWait?.({ reason: lockStatus.reason, elapsedMs: elapsed() });
      await sleep(pollIntervalMs);
      continue;
    }

    // The lock file is absent or provably stale. That is NOT yet proof the
    // directory is free: a postmaster killed mid-restart drops its lock file
    // while its shared memory is still mapped and its socket still bound.
    if (await isPortInUse(configuredPort)) {
      const actual = await probeDataDirectory(configuredPort);

      if (ownsDataDir(actual)) {
        return {
          action: "adopt",
          port: configuredPort,
          reason: `the server on port ${configuredPort} serves this data directory`,
        };
      }

      if (actual !== null) {
        // Ready, and serving something else. A real conflict, and not one a
        // different port can fix — our data directory would still be at risk.
        throw new Error(
          `Port ${configuredPort} is serving a different PostgreSQL data directory (${actual}). ` +
            `Paperclip will not start a second postmaster for ${dataDir} on another port, because the data ` +
            `directory rather than the port is the exclusive resource. Stop that server, or set ` +
            `database.embeddedPostgresPort to a free port.`,
        );
      }

      // In use but not answering: a dying socket from a killed cluster, or one
      // still binding. Wait for it to clear instead of starting elsewhere.
      if (elapsed() >= timeoutMs) {
        throw new Error(
          `Port ${configuredPort} is in use but did not answer as PostgreSQL within ${timeoutMs}ms, and the ` +
            `embedded data directory is ${dataDir}. Refusing to start a second postmaster on a different ` +
            `port. Stop whatever holds port ${configuredPort}, then retry.`,
        );
      }
      options.onWait?.({
        reason: `port ${configuredPort} is in use but not answering as PostgreSQL yet`,
        elapsedMs: elapsed(),
      });
      await sleep(pollIntervalMs);
      continue;
    }

    if (lockStatus.status === "stale") {
      removedStaleLock = removeStalePostmasterLock(dataDir).removed || removedStaleLock;
    }

    return { action: "start", port: configuredPort, removedStaleLock };
  }
}

export type EmbeddedPostgresInstanceLike = {
  initialise(): Promise<void>;
  start(): Promise<void>;
};

export type StartOrAdoptOptions<TInstance extends EmbeddedPostgresInstanceLike> =
  PlanEmbeddedPostgresStartupOptions & {
  createInstance: (port: number) => TInstance;
  /** Whether the data directory already holds an initialised cluster. */
  isClusterInitialized: () => boolean;
  getRecentLogs: () => string[];
  onAdopt?: (info: { port: number; reason: string }) => void;
  onStart?: (info: { port: number; removedStaleLock: boolean }) => void;
  onBusyRetry?: (info: { port: number; elapsedMs: number; recentLogs: string[] }) => void;
};

export type StartOrAdoptResult<TInstance extends EmbeddedPostgresInstanceLike> =
  | { mode: "adopted"; port: number }
  | { mode: "started"; port: number; instance: TInstance };

/**
 * Attach to the cluster that owns `dataDir`, or start ours on the configured
 * port — retrying while PostgreSQL reports the directory as still busy, which
 * is the normal transient state right after a watch-mode restart kills the
 * previous postmaster.
 */
export async function startOrAdoptEmbeddedPostgres<TInstance extends EmbeddedPostgresInstanceLike>(
  options: StartOrAdoptOptions<TInstance>,
): Promise<StartOrAdoptResult<TInstance>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  for (;;) {
    const remainingMs = Math.max(0, timeoutMs - (now() - startedAt));
    const plan = await planEmbeddedPostgresStartup({ ...options, timeoutMs: remainingMs });

    if (plan.action === "adopt") {
      options.onAdopt?.({ port: plan.port, reason: plan.reason });
      return { mode: "adopted", port: plan.port };
    }

    options.onStart?.({ port: plan.port, removedStaleLock: plan.removedStaleLock });
    const instance = options.createInstance(plan.port);
    if (!options.isClusterInitialized()) {
      await instance.initialise();
    }

    try {
      await instance.start();
      return { mode: "started", port: plan.port, instance };
    } catch (error) {
      const recentLogs = options.getRecentLogs();
      const elapsedMs = now() - startedAt;
      if (!isDataDirectoryBusyError(recentLogs) || elapsedMs >= timeoutMs) throw error;
      // The previous postmaster has not finished letting go. Re-plan: by the
      // next pass it may be adoptable, or genuinely gone.
      options.onBusyRetry?.({ port: plan.port, elapsedMs, recentLogs });
      await sleep(pollIntervalMs);
    }
  }
}
