import { createHash } from "node:crypto";
import { hasWorktreeUnknownOutcome } from "../agents/worktrees/errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginSubagentAdmissionError } from "../plugin-sdk/error-runtime.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import { normalizePluginsConfig } from "./config-state.js";
import type {
  ManagedRunAdmitParams,
  ManagedRunAdmitVerifierParams,
  ManagedRunExecutionIdentity,
  ManagedRunExecutionPlan,
  ManagedRunGitArtifact,
  ManagedRunRecord,
  ManagedRunStatus,
  ManagedRunWorktreeIdentity,
  PluginRuntimeManagedRuns,
} from "./runtime/types-managed-runs.js";
import type { PluginRuntime } from "./runtime/types.js";
import { PluginWorktreeValidationError } from "./runtime/worktree-errors.js";

const MANAGED_RUN_VERSION = 1 as const;
const MAX_KEY_LENGTH = 200;
const TERMINAL_STATUSES = new Set<ManagedRunStatus>(["succeeded", "failed", "cancelled"]);

type ManagedRunStore = Pick<
  PluginStateKeyedStore<ManagedRunRecord, 2>,
  "lookup" | "registerIfAbsent" | "observe" | "compareAndApply"
>;
type ManagedRunHost = Pick<
  PluginRuntime,
  "agent" | "config" | "gateway" | "sandbox" | "subagent" | "worktrees"
>;

export type CreatePluginManagedRunsOptions = {
  pluginId: string;
  runtime: ManagedRunHost;
  store: ManagedRunStore;
  assertCurrent: () => void;
  now?: () => number;
};

class ManagedRunStateError extends Error {
  readonly code = "OPENCLAW_MANAGED_RUN_UNCERTAIN";
}
class ManagedRunRefusalError extends Error {
  readonly code = "OPENCLAW_MANAGED_RUN_REFUSED";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireTrimmed(value: string, name: string, maxLength = 2_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ManagedRunRefusalError(
      "managed run " + name + " must be nonempty and at most " + maxLength + " characters.",
    );
  }
  return normalized;
}

function taskNameFor(pluginId: string, key: string): string {
  return "managed-" + sha256(pluginId + "\0" + key).slice(0, 24);
}

function workerSessionKey(agentId: string, taskName: string): string {
  return "agent:" + agentId + ":subagent:" + taskName;
}

function verifierSessionKey(agentId: string, taskName: string): string {
  return "agent:" + agentId + ":subagent:" + taskName + "-verifier";
}

function deterministicRunId(
  kind: "worker" | "verifier",
  pluginId: string,
  taskName: string,
  fingerprint: string,
): string {
  return (
    "managed-" + kind + "-" + sha256(pluginId + "\0" + taskName + "\0" + fingerprint).slice(0, 32)
  );
}

function requestFingerprint(params: {
  projectId: string;
  agentId: string;
  baseRef: string;
  baseCommit: string;
  message: string;
}): string {
  return sha256(JSON.stringify({ version: MANAGED_RUN_VERSION, ...params }));
}

function verifierFingerprint(params: {
  agentId: string;
  message: string;
  workerResultHash: string;
  artifactCommit: string;
}): string {
  return sha256(JSON.stringify({ version: MANAGED_RUN_VERSION, ...params }));
}

function terminalResultHash(
  execution: ManagedRunExecutionIdentity,
  result: {
    status: string;
    endedAt?: number;
    stopReason?: string;
    terminalReply?: unknown;
    sourceReplyDelivered?: true;
  },
): string {
  return sha256(
    JSON.stringify({
      version: MANAGED_RUN_VERSION,
      runId: execution.runId,
      sessionId: execution.sessionId,
      lifecycleRevision: execution.lifecycleRevision,
      status: result.status,
      endedAt: result.endedAt,
      stopReason: result.stopReason,
      terminalReply: result.terminalReply,
      sourceReplyDelivered: result.sourceReplyDelivered,
    }),
  );
}

function requireRecord(record: ManagedRunRecord | undefined, taskName: string): ManagedRunRecord {
  if (!record) {
    throw new ManagedRunRefusalError('Managed run "' + taskName + '" was not found.');
  }
  return record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertImmutableRecordIdentity(previous: ManagedRunRecord, next: ManagedRunRecord): void {
  for (const field of [
    "version",
    "pluginId",
    "key",
    "taskName",
    "requestFingerprint",
    "projectId",
    "repoRoot",
    "baseRef",
    "baseCommit",
    "agentId",
    "createdAt",
  ] as const) {
    if (previous[field] !== next[field]) {
      throw new Error("Managed run immutable field changed: " + field + ".");
    }
  }
  for (const field of ["worktree", "admission", "execution", "artifact"] as const) {
    if (previous[field] && JSON.stringify(previous[field]) !== JSON.stringify(next[field])) {
      throw new Error("Managed run immutable " + field + " identity cannot be replaced.");
    }
  }
  if (previous.verifier) {
    if (!next.verifier) {
      throw new Error("Managed run verifier admission cannot be removed.");
    }
    for (const field of [
      "agentId",
      "requestFingerprint",
      "workerResultHash",
      "artifact",
      "worktree",
      "admission",
      "execution",
    ] as const) {
      if (
        previous.verifier[field] &&
        JSON.stringify(previous.verifier[field]) !== JSON.stringify(next.verifier[field])
      ) {
        throw new Error("Managed run verifier immutable " + field + " cannot be replaced.");
      }
    }
  }
  if (previous.immutableResultHash && previous.immutableResultHash !== next.immutableResultHash) {
    throw new Error("Managed run immutable result hash cannot be replaced.");
  }
  if (
    previous.verifier?.evidenceHash &&
    previous.verifier.evidenceHash !== next.verifier?.evidenceHash
  ) {
    throw new Error("Managed run verifier evidence hash cannot be replaced.");
  }
}

function managedWaitParams(
  execution: Pick<ManagedRunExecutionPlan, "runId" | "sessionKey" | "requestFingerprint">,
  timeoutMs?: number,
) {
  return {
    runId: execution.runId,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    managedRun: {
      sessionKey: execution.sessionKey,
      requestFingerprint: execution.requestFingerprint,
    },
  };
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefined(entry)]),
    );
  }
  return value;
}

function statusFromWait(
  wait: Awaited<ReturnType<PluginRuntime["subagent"]["waitForRun"]>>,
): ManagedRunStatus | undefined {
  if (wait.status === "ok") {
    return "succeeded";
  }
  if (wait.status === "error" && wait.retryableTransportError !== true) {
    return "failed";
  }
  if (
    wait.status === "timeout" &&
    wait.pendingError !== true &&
    (wait.endedAt !== undefined ||
      Boolean(wait.stopReason || wait.livenessState) ||
      (["preflight", "provider", "tool_execution", "post_turn"] as readonly string[]).includes(
        wait.timeoutPhase ?? "",
      ))
  ) {
    return "failed";
  }
  return undefined;
}

export function createPluginManagedRunsRuntime(
  options: CreatePluginManagedRunsOptions,
): PluginRuntimeManagedRuns {
  const { pluginId, runtime, store, assertCurrent } = options;
  const now = options.now ?? Date.now;

  const keyContext = (rawKey: string) => {
    const key = requireTrimmed(rawKey, "key", MAX_KEY_LENGTH);
    const taskName = taskNameFor(pluginId, key);
    return { key, taskName, storeKey: taskName };
  };

  const read = async (rawKey: string) => {
    assertCurrent();
    const context = keyContext(rawKey);
    const record = await store.lookup(context.storeKey);
    assertCurrent();
    if (record && (record.version !== MANAGED_RUN_VERSION || record.pluginId !== pluginId)) {
      throw new ManagedRunRefusalError(
        "Managed run state owner or version does not match this runtime.",
      );
    }
    return { ...context, record };
  };

  const mutate = async (
    storeKey: string,
    update: (record: ManagedRunRecord) => ManagedRunRecord,
  ): Promise<ManagedRunRecord> => {
    assertCurrent();
    let observation;
    try {
      observation = await store.observe(storeKey);
    } catch (error) {
      throw new ManagedRunStateError("Managed run state observation failed.", { cause: error });
    }
    assertCurrent();
    const current = requireRecord(observation.value, storeKey);
    // Plugin state is strict JSON. Managed records use optional properties, and several
    // transitions intentionally clear them with undefined. Normalize those properties
    // away before publication so compareAndApply receives the same JSON image that the
    // retained store can persist.
    const next = stripUndefined(update(structuredClone(current))) as ManagedRunRecord;
    assertImmutableRecordIdentity(current, next);
    assertCurrent();
    let result;
    try {
      result = await store.compareAndApply(storeKey, observation.comparison, {
        operation: "update",
        action: "set",
        value: next,
      });
    } catch (error) {
      throw new ManagedRunStateError("Managed run state publication outcome is uncertain.", {
        cause: error,
      });
    }
    assertCurrent();
    if (result.status === "conflict") {
      throw new ManagedRunStateError(
        "Managed run state changed during the operation; the operation was not retried.",
      );
    }
    return next;
  };

  const policyFor = () => {
    assertCurrent();
    const cfg = runtime.config.current({ clone: true });
    const policy = normalizePluginsConfig(cfg.plugins).entries[pluginId]?.managedRuns;
    if (policy?.enabled !== true) {
      throw new ManagedRunRefusalError(
        'Managed runs are not enabled for plugin "' + pluginId + '".',
      );
    }
    return { cfg, policy };
  };

  const requireProject = (
    policy: ReturnType<typeof policyFor>["policy"],
    projectId: string,
    baseRef: string,
  ) => {
    const project = policy.projects?.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      throw new ManagedRunRefusalError(
        'Managed run project "' + projectId + '" is not registered.',
      );
    }
    if (!project.baseRefs.includes(baseRef)) {
      throw new ManagedRunRefusalError(
        'Managed run base ref "' +
          baseRef +
          '" is not registered exactly for project "' +
          projectId +
          '".',
      );
    }
    return project;
  };

  const assertAgentAllowed = (
    allowed: readonly string[] | undefined,
    agentId: string,
    kind: string,
  ) => {
    if (!allowed?.includes(agentId)) {
      throw new ManagedRunRefusalError(
        "Managed run " + kind + ' agent "' + agentId + '" is not allowlisted.',
      );
    }
  };

  const withAuthority = async <T>(params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    workspaceDir: string;
    access: "ro" | "rw";
    requireSandbox: boolean;
    run: (assertAuthorityCurrent: () => void) => Promise<T>;
  }): Promise<T> => {
    assertCurrent();
    const configFingerprint = sha256(JSON.stringify(params.cfg));
    const validate = (authority: {
      sandboxed: boolean;
      workspaceAccess: "none" | "ro" | "rw";
      confinementError?: string;
    }) => {
      if (authority.confinementError || authority.workspaceAccess !== params.access) {
        throw new ManagedRunRefusalError(
          "Managed run requires exact " +
            params.access +
            " workspace authority: " +
            (authority.confinementError ?? authority.workspaceAccess) +
            ".",
        );
      }
      if (params.requireSandbox && !authority.sandboxed) {
        throw new ManagedRunRefusalError("Managed run requires sandboxed workspace authority.");
      }
    };
    return await runtime.sandbox.withPreparedWorkspaceAuthority(
      {
        config: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      },
      async (authority) => {
        assertCurrent();
        validate(authority);
        const assertAuthorityCurrent = () => {
          assertCurrent();
          if (
            sha256(JSON.stringify(runtime.config.current({ clone: true }))) !== configFingerprint
          ) {
            throw new ManagedRunRefusalError(
              "Managed run configuration changed before run admission.",
            );
          }
          validate(
            runtime.sandbox.resolveWorkspaceAuthority({
              config: params.cfg,
              agentId: params.agentId,
              sessionKey: params.sessionKey,
            }),
          );
        };
        return await params.run(assertAuthorityCurrent);
      },
    );
  };

  const sessionIdentity = async (plan: ManagedRunExecutionPlan) => {
    assertCurrent();
    const entry = await runtime.agent.session.getSessionEntryAsync({
      agentId: plan.agentId,
      sessionKey: plan.sessionKey,
      readConsistency: "latest",
    });
    assertCurrent();
    if (!entry?.sessionId) {
      throw new ManagedRunStateError(
        "Managed run session did not publish an exact session identity.",
      );
    }
    if (
      entry.pluginOwnerId !== pluginId ||
      entry.modelSelectionLocked !== true ||
      entry.pluginManagedRun?.version !== MANAGED_RUN_VERSION ||
      entry.pluginManagedRun.pluginId !== pluginId ||
      entry.pluginManagedRun.runId !== plan.runId ||
      entry.pluginManagedRun.requestFingerprint !== plan.requestFingerprint ||
      typeof entry.pluginManagedRun.acceptedAt !== "number"
    ) {
      throw new ManagedRunRefusalError(
        "Managed run session ownership collision or unlocked plugin session was detected.",
      );
    }
    if (!entry.lifecycleRevision) {
      throw new ManagedRunStateError(
        "Managed run session did not publish an exact session identity.",
      );
    }
    return { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision };
  };

  const assertExecutionSessionCurrent = async (execution: ManagedRunExecutionIdentity) => {
    assertCurrent();
    const entry = await runtime.agent.session.getSessionEntryAsync({
      agentId: execution.agentId,
      sessionKey: execution.sessionKey,
      readConsistency: "latest",
    });
    assertCurrent();
    if (
      entry?.sessionId !== execution.sessionId ||
      entry?.lifecycleRevision !== execution.lifecycleRevision ||
      entry?.pluginOwnerId !== pluginId ||
      entry?.modelSelectionLocked !== true ||
      entry?.pluginManagedRun?.version !== MANAGED_RUN_VERSION ||
      entry.pluginManagedRun.pluginId !== pluginId ||
      entry.pluginManagedRun.runId !== execution.runId ||
      entry.pluginManagedRun.requestFingerprint !== execution.requestFingerprint ||
      typeof entry.pluginManagedRun.acceptedAt !== "number"
    ) {
      throw new ManagedRunRefusalError(
        "Managed run session lifecycle or plugin ownership no longer matches the admitted identity.",
      );
    }
  };

  const worktreeTarget = (worktree: ManagedRunWorktreeIdentity, ownerId: string) => ({
    ...worktree,
    ownerKind: "workboard" as const,
    ownerId,
  });

  const ensureWorkerLease = async (record: ManagedRunRecord) => {
    if (
      record.worktree &&
      record.lease?.status !== "released" &&
      record.lease?.status !== "retained" &&
      !(await runtime.worktrees.acquire(worktreeTarget(record.worktree, record.taskName)))
    ) {
      throw new ManagedRunRefusalError(
        "Managed run exact worktree lease could not be recovered; replacement was not touched.",
      );
    }
  };

  const ensureVerifierLease = async (record: ManagedRunRecord) => {
    const verifier = record.verifier;
    if (
      verifier?.worktree &&
      verifier.lease?.status !== "released" &&
      verifier.lease?.status !== "retained" &&
      !(await runtime.worktrees.acquire(
        worktreeTarget(verifier.worktree, record.taskName + "-verifier"),
      ))
    ) {
      throw new ManagedRunRefusalError(
        "Managed run verifier exact worktree lease could not be recovered; replacement was not touched.",
      );
    }
  };

  const cleanupWorker = async (
    storeKey: string,
    input: ManagedRunRecord,
  ): Promise<ManagedRunRecord> => {
    if (!input.worktree || input.lease?.status === "released") {
      return input;
    }
    let record = input;
    if (record.lease?.status !== "release_pending") {
      record = await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        lease: { status: "release_pending", updatedAt: now() },
      }));
    }
    try {
      const released = await runtime.worktrees.releaseExact(
        worktreeTarget(record.worktree!, record.taskName),
      );
      if (released === "mismatch") {
        return await mutate(storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          lease: {
            status: "retained",
            updatedAt: now(),
            error: "exact worktree identity no longer exists; replacement was not touched",
          },
        }));
      }
      if (released === "already_retired") {
        return await mutate(storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          lease: { status: "released", updatedAt: now() },
        }));
      }
      const removed = await runtime.worktrees.removeIfLosslessExact(
        worktreeTarget(record.worktree!, record.taskName),
      );
      if (removed === "retained" || removed === "mismatch") {
        return await mutate(storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          lease: {
            status: "retained",
            updatedAt: now(),
            error:
              removed === "mismatch"
                ? "lease released; exact checkout identity no longer matches"
                : "lease released; lossless checkout removal was refused",
          },
        }));
      }
      return await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        lease: { status: "released", updatedAt: now() },
      }));
    } catch (error) {
      await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        lease: { status: "release_pending", updatedAt: now(), error: errorMessage(error) },
      }));
      throw new ManagedRunStateError("Managed run worktree release outcome is uncertain.", {
        cause: error,
      });
    }
  };

  const cleanupVerifierWorktree = async (
    storeKey: string,
    input: ManagedRunRecord,
  ): Promise<ManagedRunRecord> => {
    const verifier = input.verifier;
    if (!verifier?.worktree || verifier.lease?.status === "released") {
      return input;
    }
    let record = input;
    if (verifier.lease?.status !== "release_pending") {
      record = await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        verifier: {
          ...latest.verifier!,
          lease: { status: "release_pending", updatedAt: now() },
        },
      }));
    }
    const ownerId = record.taskName + "-verifier";
    try {
      const released = await runtime.worktrees.releaseExact(
        worktreeTarget(record.verifier!.worktree!, ownerId),
      );
      if (released === "mismatch") {
        return await mutate(storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            lease: {
              status: "retained",
              updatedAt: now(),
              error:
                "exact verifier worktree identity no longer exists; replacement was not touched",
            },
          },
        }));
      }
      if (released === "already_retired") {
        return await mutate(storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            lease: { status: "released", updatedAt: now() },
          },
        }));
      }
      const removed = await runtime.worktrees.removeIfLosslessExact(
        worktreeTarget(record.verifier!.worktree!, ownerId),
      );
      if (removed === "retained" || removed === "mismatch") {
        return await mutate(storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            lease: {
              status: "retained",
              updatedAt: now(),
              error:
                removed === "mismatch"
                  ? "lease released; exact verifier checkout identity no longer matches"
                  : "lease released; lossless verifier checkout removal was refused",
            },
          },
        }));
      }
      return await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        verifier: {
          ...latest.verifier!,
          lease: { status: "released", updatedAt: now() },
        },
      }));
    } catch (error) {
      await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        verifier: {
          ...latest.verifier!,
          lease: { status: "release_pending", updatedAt: now(), error: errorMessage(error) },
        },
      }));
      throw new ManagedRunStateError(
        "Managed run verifier worktree release outcome is uncertain.",
        {
          cause: error,
        },
      );
    }
  };

  const cleanupVerifier = async (
    storeKey: string,
    input: ManagedRunRecord,
  ): Promise<ManagedRunRecord> => {
    let record = await cleanupVerifierWorktree(storeKey, input);
    if (
      !record.verifier ||
      !TERMINAL_STATUSES.has(record.verifier.status) ||
      !record.artifact ||
      record.artifactRetention?.status === "released"
    ) {
      return record;
    }
    if (record.artifactRetention?.status !== "release_pending") {
      record = await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        artifactRetention: { status: "release_pending", updatedAt: now() },
      }));
    }
    try {
      const released = await runtime.worktrees.releaseGitArtifact({
        repoRoot: record.repoRoot,
        retentionRef: record.artifact!.retentionRef,
        commit: record.artifact!.commit,
      });
      return await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        artifactRetention:
          released === "mismatch"
            ? {
                status: "retained",
                updatedAt: now(),
                error: "artifact retention ref no longer matches; replacement was not touched",
              }
            : { status: "released", updatedAt: now() },
      }));
    } catch (error) {
      await mutate(storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        artifactRetention: {
          status: "release_pending",
          updatedAt: now(),
          error: errorMessage(error),
        },
      }));
      throw new ManagedRunStateError(
        "Managed run artifact reachability release outcome is uncertain.",
        { cause: error },
      );
    }
  };

  const recoverWorkerAdmission = async (
    storeKey: string,
    record: ManagedRunRecord,
    retry?: { message: string; cfg: OpenClawConfig; requireSandbox: boolean },
  ) => {
    const plan = record.admission;
    if (!plan) {
      throw new ManagedRunStateError("Managed run uncertain admission has no durable run plan.");
    }
    let identity;
    try {
      identity = await sessionIdentity(plan);
    } catch (error) {
      if (error instanceof ManagedRunRefusalError) {
        throw error;
      }
      const entry = await runtime.agent.session.getSessionEntryAsync({
        agentId: plan.agentId,
        sessionKey: plan.sessionKey,
        readConsistency: "latest",
      });
      assertCurrent();
      const binding = entry?.pluginManagedRun;
      const exactAcceptedSession =
        Boolean(entry?.sessionId) &&
        !entry?.lifecycleRevision &&
        entry?.pluginOwnerId === pluginId &&
        entry?.modelSelectionLocked === true &&
        binding?.version === MANAGED_RUN_VERSION &&
        binding.pluginId === pluginId &&
        binding.runId === plan.runId &&
        binding.requestFingerprint === plan.requestFingerprint &&
        typeof binding.acceptedAt === "number";
      if (exactAcceptedSession) {
        const settlement = await runtime.subagent.waitForRun(managedWaitParams(plan, 0));
        assertCurrent();
        if (!statusFromWait(settlement)) {
          throw new ManagedRunStateError(
            "Managed run accepted session has no lifecycleRevision and is not terminal; no replacement was dispatched.",
            { cause: error },
          );
        }
        const failed = await mutate(storeKey, (latest) => ({
          ...latest,
          status: "failed",
          updatedAt: now(),
          error:
            "Accepted managed run reached terminal state but its durable session did not publish lifecycleRevision; " +
            "the unprovable lifecycle identity was retired without replacement.",
        }));
        return await cleanupWorker(storeKey, failed);
      }
      throw new ManagedRunStateError(
        "Managed run admission remains uncertain; no second worker was dispatched.",
        { cause: error },
      );
    }
    if (retry) {
      const wait = await runtime.subagent.waitForRun(managedWaitParams(plan, 0));
      const failure = wait.error ?? wait.stopReason;
      if (
        wait.status === "error" &&
        failure ===
          "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd"
      ) {
        const retried = await withAuthority({
          cfg: retry.cfg,
          agentId: plan.agentId,
          sessionKey: plan.sessionKey,
          workspaceDir: plan.worktree.path,
          access: "rw",
          requireSandbox: retry.requireSandbox,
          run: async (assertAuthorityCurrent) =>
            await runtime.subagent.run({
              assertCurrent: assertAuthorityCurrent,
              sessionKey: plan.sessionKey,
              message:
                retry.message +
                "\n\nHost output contract: commit all intended changes and leave the managed " +
                "checkout clean; the host will use the exact resulting Git commit as the artifact.",
              promptMode: "minimal",
              deliver: false,
              idempotencyKey: plan.runId,
              managedRun: {
                version: MANAGED_RUN_VERSION,
                runId: plan.runId,
                requestFingerprint: plan.requestFingerprint,
              },
            }),
        });
        if (
          retried.runId !== plan.runId ||
          (retried.sessionKey ?? plan.sessionKey) !== plan.sessionKey
        ) {
          throw new ManagedRunStateError(
            "Managed run preflight recovery returned a mismatched deterministic identity.",
          );
        }
        // The replay may race a session replacement. Publish only the identity observed
        // after the deterministic replay was accepted.
        identity = await sessionIdentity(plan);
      }
    }
    return await mutate(storeKey, (latest) => ({
      ...latest,
      status: "running",
      updatedAt: now(),
      execution: { ...plan, ...identity },
      error: undefined,
    }));
  };

  const recoverVerifierAdmission = async (storeKey: string, record: ManagedRunRecord) => {
    const plan = record.verifier?.admission;
    if (!plan) {
      throw new ManagedRunStateError(
        "Managed run verifier uncertain admission has no durable run plan.",
      );
    }
    let identity;
    try {
      identity = await sessionIdentity(plan);
    } catch (error) {
      if (error instanceof ManagedRunRefusalError) {
        throw error;
      }
      const entry = await runtime.agent.session.getSessionEntryAsync({
        agentId: plan.agentId,
        sessionKey: plan.sessionKey,
        readConsistency: "latest",
      });
      assertCurrent();
      const binding = entry?.pluginManagedRun;
      const exactAcceptedSession =
        Boolean(entry?.sessionId) &&
        !entry?.lifecycleRevision &&
        entry?.pluginOwnerId === pluginId &&
        entry?.modelSelectionLocked === true &&
        binding?.version === MANAGED_RUN_VERSION &&
        binding.pluginId === pluginId &&
        binding.runId === plan.runId &&
        binding.requestFingerprint === plan.requestFingerprint &&
        typeof binding.acceptedAt === "number";
      if (exactAcceptedSession) {
        const settlement = await runtime.subagent.waitForRun(managedWaitParams(plan, 0));
        assertCurrent();
        if (!statusFromWait(settlement)) {
          throw new ManagedRunStateError(
            "Managed run verifier accepted session has no lifecycleRevision and is not terminal; no replacement was dispatched.",
            { cause: error },
          );
        }
        const failed = await mutate(storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            status: "failed",
            error:
              "Accepted managed run verifier reached terminal state but its durable session did not publish lifecycleRevision; " +
              "the unprovable lifecycle identity was retired without replacement.",
          },
        }));
        return await cleanupVerifier(storeKey, failed);
      }
      throw new ManagedRunStateError(
        "Managed run verifier admission remains uncertain; no second verifier was dispatched.",
        { cause: error },
      );
    }
    return await mutate(storeKey, (latest) => ({
      ...latest,
      updatedAt: now(),
      verifier: {
        ...latest.verifier!,
        status: "running",
        execution: { ...plan, ...identity },
        error: undefined,
      },
    }));
  };

  const inspectWorker = async (rawKey: string, timeoutMs?: number) => {
    const current = await read(rawKey);
    let record = requireRecord(current.record, current.taskName);
    if (["admitting", "admission_uncertain"].includes(record.status)) {
      record = await recoverWorkerAdmission(current.storeKey, record);
    }
    if (TERMINAL_STATUSES.has(record.status)) {
      return await cleanupWorker(current.storeKey, record);
    }
    await ensureWorkerLease(record);
    if (!record.execution || record.status === "prepared" || record.status === "worktree_ready") {
      return record;
    }
    const execution = record.execution;
    await assertExecutionSessionCurrent(execution);
    let hash = record.immutableResultHash;
    if (!hash) {
      const wait = await runtime.subagent.waitForRun(managedWaitParams(execution, timeoutMs));
      assertCurrent();
      const status = statusFromWait(wait);
      if (!status) {
        return record;
      }
      if (status === "failed") {
        const failed = await mutate(current.storeKey, (latest) => ({
          ...latest,
          status,
          updatedAt: now(),
          error: wait.error ?? wait.stopReason ?? "managed run failed",
        }));
        return await cleanupWorker(current.storeKey, failed);
      }
      hash = terminalResultHash(execution, wait);
      record = await mutate(current.storeKey, (latest) => ({
        ...latest,
        status: "finalizing",
        updatedAt: now(),
        immutableResultHash: latest.immutableResultHash ?? hash,
        error: undefined,
      }));
    }
    let captured: { commit: string; retentionRef: string };
    try {
      captured = await runtime.worktrees.captureGitArtifact({
        ...worktreeTarget(execution.worktree, record.taskName),
        baseCommit: record.baseCommit,
      });
    } catch (error) {
      if (!(error instanceof PluginWorktreeValidationError)) {
        throw new ManagedRunStateError("Managed run artifact finalization outcome is uncertain.", {
          cause: error,
        });
      }
      const failed = await mutate(current.storeKey, (latest) => ({
        ...latest,
        status: "failed",
        updatedAt: now(),
        error: error.message,
      }));
      return await cleanupWorker(current.storeKey, failed);
    }
    assertCurrent();
    const artifact: ManagedRunGitArtifact = {
      kind: "git_commit",
      commit: captured.commit,
      baseCommit: record.baseCommit,
      worktreeId: execution.worktree.id,
      retentionRef: captured.retentionRef,
    };
    const succeeded = await mutate(current.storeKey, (latest) => {
      if (latest.immutableResultHash !== hash) {
        throw new Error("Managed run terminal result changed after finalization started.");
      }
      return {
        ...latest,
        status: "succeeded",
        updatedAt: now(),
        artifact: latest.artifact ?? artifact,
        artifactRetention: latest.artifactRetention ?? { status: "retained", updatedAt: now() },
        error: undefined,
      };
    });
    return await cleanupWorker(current.storeKey, succeeded);
  };

  const api: PluginRuntimeManagedRuns = {
    async admit(input: ManagedRunAdmitParams) {
      assertCurrent();
      const key = requireTrimmed(input.key, "key", MAX_KEY_LENGTH);
      const projectId = requireTrimmed(input.projectId, "projectId");
      const agentId = requireTrimmed(input.agentId, "agentId");
      const baseRef = requireTrimmed(input.baseRef, "baseRef");
      const message = requireTrimmed(input.message, "message", 100_000);
      const context = keyContext(key);
      const { cfg, policy } = policyFor();
      assertAgentAllowed(policy.agentAllowlist, agentId, "worker");
      const project = requireProject(policy, projectId, baseRef);
      let existing = await store.lookup(context.storeKey);
      assertCurrent();
      if (
        existing &&
        (existing.version !== MANAGED_RUN_VERSION || existing.pluginId !== pluginId)
      ) {
        throw new ManagedRunRefusalError(
          "Managed run task identity is owned by another plugin or version.",
        );
      }
      const baseCommit =
        existing?.baseCommit ??
        (await runtime.worktrees.resolveCommit({ repoRoot: project.repoRoot, ref: baseRef }));
      assertCurrent();
      const fingerprint = requestFingerprint({ projectId, agentId, baseRef, baseCommit, message });
      if (existing && existing.requestFingerprint !== fingerprint) {
        throw new ManagedRunRefusalError(
          "Managed run key already exists with a different request fingerprint.",
        );
      }
      if (
        existing &&
        (existing.projectId !== projectId ||
          existing.repoRoot !== project.repoRoot ||
          existing.baseRef !== baseRef ||
          existing.agentId !== agentId)
      ) {
        throw new ManagedRunRefusalError(
          "Managed run deterministic task ownership collision detected.",
        );
      }
      if (
        existing &&
        ["admitting", "admission_uncertain"].includes(existing.status) &&
        existing.admission
      ) {
        return await recoverWorkerAdmission(context.storeKey, existing, {
          message,
          cfg,
          requireSandbox: policy.requireSandbox !== false,
        });
      }
      // Workspace-authority validation runs before subagent dispatch. If that deterministic
      // pre-dispatch refusal retained the exact checkout, the same fingerprint can safely
      // reacquire it after configuration is corrected; no worker identity ever existed.
      if (
        existing?.status === "failed" &&
        !existing.execution &&
        existing.admission &&
        existing.worktree &&
        existing.lease?.status === "retained" &&
        existing.error?.startsWith("Managed run requires exact ") &&
        existing.error.includes(" workspace authority:")
      ) {
        existing = await mutate(context.storeKey, (latest) => ({
          ...latest,
          status: "worktree_ready",
          updatedAt: now(),
          lease: { status: "leased", updatedAt: now() },
          error: undefined,
        }));
      }
      if (
        existing &&
        !["prepared", "worktree_ready", "admission_uncertain"].includes(existing.status)
      ) {
        if (TERMINAL_STATUSES.has(existing.status)) {
          return await cleanupWorker(context.storeKey, existing);
        }
        await ensureWorkerLease(existing);
        return existing;
      }
      const timestamp = now();
      const prepared: ManagedRunRecord = existing ?? {
        version: MANAGED_RUN_VERSION,
        pluginId,
        key,
        taskName: context.taskName,
        requestFingerprint: fingerprint,
        projectId,
        repoRoot: project.repoRoot,
        baseRef,
        baseCommit,
        agentId,
        status: "prepared",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!existing) {
        let inserted;
        try {
          inserted = await store.registerIfAbsent(context.storeKey, prepared);
        } catch (error) {
          throw new ManagedRunStateError(
            "Managed run preparation publication outcome is uncertain; refusing execution.",
            { cause: error },
          );
        }
        assertCurrent();
        if (!inserted) {
          existing = await store.lookup(context.storeKey);
          assertCurrent();
          if (
            !existing ||
            existing.pluginId !== pluginId ||
            existing.requestFingerprint !== fingerprint
          ) {
            throw new ManagedRunRefusalError(
              "Managed run deterministic task identity collided during preparation.",
            );
          }
          if (
            ["admitting", "admission_uncertain"].includes(existing.status) &&
            existing.admission
          ) {
            return await recoverWorkerAdmission(context.storeKey, existing);
          }
          if (!["prepared", "worktree_ready", "admission_uncertain"].includes(existing.status)) {
            return existing;
          }
        }
      }
      let record = existing ?? prepared;
      let dispatchAttempted = false;
      try {
        let worktree = record.worktree;
        if (worktree) {
          const acquired = await runtime.worktrees.acquire(
            worktreeTarget(worktree, context.taskName),
          );
          if (!acquired) {
            throw new ManagedRunRefusalError(
              "Managed run worktree lease could not be reacquired for the exact identity.",
            );
          }
        } else {
          try {
            worktree = await runtime.worktrees.create({
              repoRoot: project.repoRoot,
              name: context.taskName,
              baseRef,
              checkoutCommit: baseCommit,
              ownerKind: "workboard",
              ownerId: context.taskName,
              commitGuard: assertCurrent,
            });
          } catch (error) {
            if (!hasWorktreeUnknownOutcome(error)) {
              throw error;
            }
            await mutate(context.storeKey, (latest) => ({
              ...latest,
              status: "admission_uncertain",
              updatedAt: now(),
              error: "worktree creation outcome is uncertain: " + errorMessage(error),
            }));
            throw new ManagedRunStateError(
              "Managed run worktree creation outcome is uncertain; retrying may only adopt the exact owner.",
              { cause: error },
            );
          }
          assertCurrent();
          record = await mutate(context.storeKey, (latest) => ({
            ...latest,
            status: "worktree_ready",
            updatedAt: now(),
            worktree,
            lease: { status: "leased", updatedAt: now() },
            error: undefined,
          }));
        }
        await runtime.worktrees.assertPinnedCommit({
          ...worktreeTarget(worktree, context.taskName),
          commit: baseCommit,
        });
        const sessionKey = workerSessionKey(agentId, context.taskName);
        const plan: ManagedRunExecutionPlan = {
          agentId,
          sessionKey,
          runId: deterministicRunId("worker", pluginId, context.taskName, fingerprint),
          requestFingerprint: fingerprint,
          worktree,
        };
        record = await mutate(context.storeKey, (latest) => ({
          ...latest,
          status: "admitting",
          updatedAt: now(),
          admission: plan,
          error: undefined,
        }));
        const run = await withAuthority({
          cfg,
          agentId,
          sessionKey,
          workspaceDir: worktree.path,
          access: "rw",
          requireSandbox: policy.requireSandbox !== false,
          run: async (assertAuthorityCurrent) => {
            dispatchAttempted = true;
            return await runtime.subagent.run({
              assertCurrent: assertAuthorityCurrent,
              sessionKey,
              message:
                message +
                "\n\nHost output contract: commit all intended changes and leave the managed " +
                "checkout clean; the host will use the exact resulting Git commit as the artifact.",
              promptMode: "minimal",
              deliver: false,
              idempotencyKey: plan.runId,
              managedRun: {
                version: MANAGED_RUN_VERSION,
                runId: plan.runId,
                requestFingerprint: fingerprint,
              },
            });
          },
        });
        assertCurrent();
        if (run.runId !== plan.runId || (run.sessionKey ?? sessionKey) !== sessionKey) {
          throw new Error("Managed run host returned a mismatched deterministic run identity.");
        }
        const identity = await sessionIdentity(plan);
        return await mutate(context.storeKey, (latest) => ({
          ...latest,
          status: "running",
          updatedAt: now(),
          execution: { ...plan, ...identity },
          error: undefined,
        }));
      } catch (error) {
        if (error instanceof ManagedRunStateError) {
          throw error;
        }
        const uncertain =
          dispatchAttempted &&
          !(error instanceof PluginSubagentAdmissionError && error.outcome === "refused");
        const status = uncertain ? "admission_uncertain" : "failed";
        let published: ManagedRunRecord;
        try {
          published = await mutate(context.storeKey, (latest) => ({
            ...latest,
            status,
            updatedAt: now(),
            error: errorMessage(error),
          }));
        } catch (publicationError) {
          throw new AggregateError(
            [error, publicationError],
            "Managed run admission outcome and recovery publication are uncertain.",
            { cause: publicationError },
          );
        }
        if (!uncertain) {
          await cleanupWorker(context.storeKey, published);
          throw error;
        }
        throw new ManagedRunStateError(
          "Managed run admission outcome is uncertain; the durable run identity must be " +
            "reconciled before any retry.",
          { cause: error },
        );
      }
    },

    async find({ key }) {
      return (await read(key)).record;
    },

    async inspect({ key, timeoutMs }) {
      return await inspectWorker(key, timeoutMs);
    },

    async cancel({ key }) {
      const current = await read(key);
      let record = requireRecord(current.record, current.taskName);
      if (["admitting", "admission_uncertain"].includes(record.status)) {
        record = await recoverWorkerAdmission(current.storeKey, record);
      }
      if (TERMINAL_STATUSES.has(record.status)) {
        return await cleanupWorker(current.storeKey, record);
      }
      await ensureWorkerLease(record);
      if (!record.execution) {
        const cancelled = await mutate(current.storeKey, (latest) => ({
          ...latest,
          status: "cancelled",
          updatedAt: now(),
          error: "cancelled before run admission",
        }));
        return await cleanupWorker(current.storeKey, cancelled);
      }
      await assertExecutionSessionCurrent(record.execution);
      record = await mutate(current.storeKey, (latest) => ({
        ...latest,
        status: "cancelling",
        updatedAt: now(),
      }));
      try {
        const execution = record.execution!;
        const result = await runtime.subagent.abortManagedRun({
          runId: execution.runId,
          sessionKey: execution.sessionKey,
          sessionId: execution.sessionId,
          lifecycleRevision: execution.lifecycleRevision,
          requestFingerprint: execution.requestFingerprint,
        });
        assertCurrent();
        if (result.aborted !== true) {
          const reconciled = await inspectWorker(key, 0);
          if (TERMINAL_STATUSES.has(reconciled.status)) {
            return reconciled;
          }
          await mutate(current.storeKey, (latest) => ({
            ...latest,
            status: "cancellation_uncertain",
            updatedAt: now(),
            error: "exact run was not abortable and has not settled",
          }));
          throw new ManagedRunStateError(
            "Managed run cancellation outcome is uncertain; exact-run reconciliation is required.",
          );
        }
        const settlement = await runtime.subagent.waitForRun(managedWaitParams(execution, 30_000));
        assertCurrent();
        if (!statusFromWait(settlement)) {
          await mutate(current.storeKey, (latest) => ({
            ...latest,
            status: "cancellation_uncertain",
            updatedAt: now(),
            error: "abort was accepted but exact run settlement is still pending",
          }));
          throw new ManagedRunStateError(
            "Managed run abort was accepted but terminal settlement is uncertain.",
          );
        }
        const cancelled = await mutate(current.storeKey, (latest) => ({
          ...latest,
          status: "cancelled",
          updatedAt: now(),
          error: "cancelled after exact-run settlement",
        }));
        return await cleanupWorker(current.storeKey, cancelled);
      } catch (error) {
        if (error instanceof ManagedRunStateError) {
          throw error;
        }
        await mutate(current.storeKey, (latest) => ({
          ...latest,
          status: "cancellation_uncertain",
          updatedAt: now(),
          error: errorMessage(error),
        }));
        const reconciled = await inspectWorker(key, 0).catch(() => undefined);
        if (reconciled && TERMINAL_STATUSES.has(reconciled.status)) {
          return reconciled;
        }
        throw new ManagedRunStateError(
          "Managed run cancellation outcome is uncertain; exact-run reconciliation is required.",
          { cause: error },
        );
      }
    },

    async admitVerifier(input: ManagedRunAdmitVerifierParams) {
      const current = await read(input.key);
      let record = requireRecord(current.record, current.taskName);
      if (record.status !== "succeeded" || !record.immutableResultHash || !record.artifact) {
        throw new ManagedRunRefusalError(
          "Managed run verifier admission requires an immutable host-inspected worker artifact.",
        );
      }
      const workerArtifact = record.artifact;
      const workerResultHash = record.immutableResultHash;
      const agentId = requireTrimmed(input.agentId, "agentId");
      const message = requireTrimmed(input.message, "message", 100_000);
      const { cfg, policy } = policyFor();
      assertAgentAllowed(policy.verifierAgentAllowlist, agentId, "verifier");
      if (agentId === record.agentId) {
        throw new ManagedRunRefusalError("Managed run verifier must use a separate agent.");
      }
      const fingerprint = verifierFingerprint({
        agentId,
        message,
        workerResultHash,
        artifactCommit: workerArtifact.commit,
      });
      if (record.verifier) {
        if (record.verifier.requestFingerprint !== fingerprint) {
          throw new ManagedRunRefusalError(
            "Managed run verifier already exists with a different request fingerprint.",
          );
        }
        if (
          ["admitting", "admission_uncertain"].includes(record.verifier.status) &&
          record.verifier.admission
        ) {
          return await recoverVerifierAdmission(current.storeKey, record);
        }
        if (
          !["prepared", "worktree_ready", "admission_uncertain"].includes(record.verifier.status)
        ) {
          if (TERMINAL_STATUSES.has(record.verifier.status)) {
            return await cleanupVerifier(current.storeKey, record);
          }
          await ensureVerifierLease(record);
          return record;
        }
      } else {
        record = await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            agentId,
            requestFingerprint: fingerprint,
            status: "prepared",
            workerResultHash,
            artifact: workerArtifact,
          },
        }));
      }
      const verifierTaskName = record.taskName + "-verifier";
      let dispatchAttempted = false;
      try {
        let worktree = record.verifier?.worktree;
        if (worktree) {
          const acquired = await runtime.worktrees.acquire(
            worktreeTarget(worktree, verifierTaskName),
          );
          if (!acquired) {
            throw new ManagedRunRefusalError(
              "Managed run verifier worktree lease could not be reacquired for the exact identity.",
            );
          }
        } else {
          try {
            worktree = await runtime.worktrees.create({
              repoRoot: record.repoRoot,
              name: verifierTaskName,
              baseRef: workerArtifact.commit,
              checkoutCommit: workerArtifact.commit,
              ownerKind: "workboard",
              ownerId: verifierTaskName,
              commitGuard: assertCurrent,
            });
          } catch (error) {
            if (!hasWorktreeUnknownOutcome(error)) {
              throw error;
            }
            await mutate(current.storeKey, (latest) => ({
              ...latest,
              updatedAt: now(),
              verifier: {
                ...latest.verifier!,
                status: "admission_uncertain",
                error: "worktree creation outcome is uncertain: " + errorMessage(error),
              },
            }));
            throw new ManagedRunStateError(
              "Managed run verifier worktree creation outcome is uncertain; retrying may " +
                "only adopt the exact owner.",
              { cause: error },
            );
          }
          record = await mutate(current.storeKey, (latest) => ({
            ...latest,
            updatedAt: now(),
            verifier: {
              ...latest.verifier!,
              status: "worktree_ready",
              worktree,
              lease: { status: "leased", updatedAt: now() },
              error: undefined,
            },
          }));
        }
        if (!worktree) {
          throw new ManagedRunStateError(
            "Managed run verifier worktree identity was not published.",
          );
        }
        await runtime.worktrees.assertPinnedCommit({
          ...worktreeTarget(worktree, verifierTaskName),
          commit: workerArtifact.commit,
        });
        const sessionKey = verifierSessionKey(agentId, record.taskName);
        const plan: ManagedRunExecutionPlan = {
          agentId,
          sessionKey,
          runId: deterministicRunId("verifier", pluginId, record.taskName, fingerprint),
          requestFingerprint: fingerprint,
          worktree,
        };
        record = await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            status: "admitting",
            admission: plan,
            error: undefined,
          },
        }));
        const run = await withAuthority({
          cfg,
          agentId,
          sessionKey,
          workspaceDir: worktree.path,
          access: "ro",
          requireSandbox: true,
          run: async (assertAuthorityCurrent) => {
            dispatchAttempted = true;
            return await runtime.subagent.run({
              assertCurrent: assertAuthorityCurrent,
              sessionKey,
              message:
                "Verify exact immutable Git commit " +
                workerArtifact.commit +
                " (worker result hash " +
                workerResultHash +
                "). The checkout is pinned read-only to that commit.\n\n" +
                message,
              promptMode: "minimal",
              deliver: false,
              idempotencyKey: plan.runId,
              managedRun: {
                version: MANAGED_RUN_VERSION,
                runId: plan.runId,
                requestFingerprint: fingerprint,
              },
            });
          },
        });
        if (run.runId !== plan.runId || (run.sessionKey ?? sessionKey) !== sessionKey) {
          throw new Error("Managed run verifier returned a mismatched deterministic run identity.");
        }
        const identity = await sessionIdentity(plan);
        return await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            status: "running",
            execution: { ...plan, ...identity },
            error: undefined,
          },
        }));
      } catch (error) {
        if (error instanceof ManagedRunStateError) {
          throw error;
        }
        const uncertain =
          dispatchAttempted &&
          !(error instanceof PluginSubagentAdmissionError && error.outcome === "refused");
        const status = uncertain ? "admission_uncertain" : "failed";
        const published = await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            status,
            error: errorMessage(error),
          },
        }));
        if (!uncertain) {
          await cleanupVerifier(current.storeKey, published);
          throw error;
        }
        throw new ManagedRunStateError(
          "Managed run verifier admission outcome is uncertain; the exact run identity must be reconciled.",
          { cause: error },
        );
      }
    },

    async inspectVerifier({ key, timeoutMs }) {
      const current = await read(key);
      let record = requireRecord(current.record, current.taskName);
      let verifier = record.verifier;
      if (!verifier) {
        throw new ManagedRunRefusalError("Managed run verifier has not been admitted.");
      }
      if (["admitting", "admission_uncertain"].includes(verifier.status)) {
        record = await recoverVerifierAdmission(current.storeKey, record);
        verifier = record.verifier!;
      }
      if (TERMINAL_STATUSES.has(verifier.status)) {
        return await cleanupVerifier(current.storeKey, record);
      }
      await ensureVerifierLease(record);
      if (!verifier.execution) {
        return record;
      }
      const execution = verifier.execution;
      await assertExecutionSessionCurrent(execution);
      let hash = verifier.evidenceHash;
      if (!hash) {
        const wait = await runtime.subagent.waitForRun(managedWaitParams(execution, timeoutMs));
        assertCurrent();
        const status = statusFromWait(wait);
        if (!status) {
          return record;
        }
        if (status === "failed") {
          const failed = await mutate(current.storeKey, (latest) => ({
            ...latest,
            updatedAt: now(),
            verifier: {
              ...latest.verifier!,
              status,
              error: wait.error ?? wait.stopReason ?? "managed run verifier failed",
            },
          }));
          return await cleanupVerifier(current.storeKey, failed);
        }
        hash = terminalResultHash(execution, wait);
        record = await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            status: "finalizing",
            evidenceHash: latest.verifier!.evidenceHash ?? hash,
            error: undefined,
          },
        }));
        verifier = record.verifier!;
      }
      try {
        await runtime.worktrees.assertPinnedCommit({
          ...worktreeTarget(execution.worktree, record.taskName + "-verifier"),
          commit: verifier.artifact.commit,
        });
      } catch (error) {
        if (!(error instanceof PluginWorktreeValidationError)) {
          throw new ManagedRunStateError(
            "Managed run verifier finalization outcome is uncertain.",
            { cause: error },
          );
        }
        const failed = await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: { ...latest.verifier!, status: "failed", error: error.message },
        }));
        return await cleanupVerifier(current.storeKey, failed);
      }
      assertCurrent();
      const succeeded = await mutate(current.storeKey, (latest) => {
        if (latest.verifier?.evidenceHash !== hash) {
          throw new Error("Managed run verifier evidence changed after finalization started.");
        }
        return {
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier,
            status: "succeeded",
            error: undefined,
          },
        };
      });
      return await cleanupVerifier(current.storeKey, succeeded);
    },

    async cancelVerifier({ key }) {
      const current = await read(key);
      let record = requireRecord(current.record, current.taskName);
      if (!record.verifier) {
        throw new ManagedRunRefusalError("Managed run verifier has not been admitted.");
      }
      if (["admitting", "admission_uncertain"].includes(record.verifier.status)) {
        record = await recoverVerifierAdmission(current.storeKey, record);
      }
      const verifier = record.verifier!;
      if (TERMINAL_STATUSES.has(verifier.status)) {
        return await cleanupVerifier(current.storeKey, record);
      }
      await ensureVerifierLease(record);
      if (!verifier.execution) {
        const cancelled = await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            status: "cancelled",
            error: "cancelled before run admission",
          },
        }));
        return await cleanupVerifier(current.storeKey, cancelled);
      }
      await assertExecutionSessionCurrent(verifier.execution);
      record = await mutate(current.storeKey, (latest) => ({
        ...latest,
        updatedAt: now(),
        verifier: { ...latest.verifier!, status: "cancelling" },
      }));
      try {
        const execution = record.verifier!.execution!;
        const result = await runtime.subagent.abortManagedRun({
          runId: execution.runId,
          sessionKey: execution.sessionKey,
          sessionId: execution.sessionId,
          lifecycleRevision: execution.lifecycleRevision,
          requestFingerprint: execution.requestFingerprint,
        });
        if (result.aborted !== true) {
          const reconciled = await api.inspectVerifier({ key, timeoutMs: 0 });
          if (reconciled.verifier && TERMINAL_STATUSES.has(reconciled.verifier.status)) {
            return reconciled;
          }
          await mutate(current.storeKey, (latest) => ({
            ...latest,
            updatedAt: now(),
            verifier: {
              ...latest.verifier!,
              status: "cancellation_uncertain",
              error: "exact verifier run was not abortable and has not settled",
            },
          }));
          throw new ManagedRunStateError("Managed run verifier cancellation outcome is uncertain.");
        }
        const settlement = await runtime.subagent.waitForRun(managedWaitParams(execution, 30_000));
        if (!statusFromWait(settlement)) {
          await mutate(current.storeKey, (latest) => ({
            ...latest,
            updatedAt: now(),
            verifier: {
              ...latest.verifier!,
              status: "cancellation_uncertain",
              error: "abort was accepted but exact verifier settlement is still pending",
            },
          }));
          throw new ManagedRunStateError(
            "Managed run verifier abort was accepted but terminal settlement is uncertain.",
          );
        }
        const cancelled = await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            status: "cancelled",
            error: "cancelled after exact-run settlement",
          },
        }));
        return await cleanupVerifier(current.storeKey, cancelled);
      } catch (error) {
        if (error instanceof ManagedRunStateError) {
          throw error;
        }
        await mutate(current.storeKey, (latest) => ({
          ...latest,
          updatedAt: now(),
          verifier: {
            ...latest.verifier!,
            status: "cancellation_uncertain",
            error: errorMessage(error),
          },
        }));
        const reconciled = await api.inspectVerifier({ key, timeoutMs: 0 }).catch(() => undefined);
        if (reconciled?.verifier && TERMINAL_STATUSES.has(reconciled.verifier.status)) {
          return reconciled;
        }
        throw new ManagedRunStateError(
          "Managed run verifier cancellation outcome is uncertain; exact-run reconciliation is required.",
          { cause: error },
        );
      }
    },
  };

  return api;
}
/* oxlint-disable max-lines -- keep durable lifecycle transitions in one auditable state machine. */
