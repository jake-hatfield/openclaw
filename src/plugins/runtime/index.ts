import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceAuthority } from "../../agents/sandbox/workspace-authority.js";
import { withPreparedSessionCapabilityRead } from "../../agents/subagents/spawn/subagent-session-store.js";
import { runWithLocalStateOwner } from "../../cli/local-state-owner.js";
import { captureMemoryExactSessionReader } from "../../config/sessions/session-accessor.memory-exact-read.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  listImageGenerationProviders,
  listMusicGenerationProviders,
  listVideoGenerationProviders,
} from "../../media-generation/registry.js";
import { RequestScopedSubagentRuntimeError } from "../../plugin-sdk/error-runtime.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import {
  listWebSearchProviders,
  listWebSearchProvidersAsync,
  runWebSearch,
} from "../../web-search/runtime.js";
import {
  resolveNativePluginModelAuth,
  resolveNativePluginModelConfig,
} from "../loader-runtime-load.js";
import { warnPluginSdkDeprecation } from "../sdk-deprecation.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { createRuntimeBase } from "./runtime-base.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { subscribeRuntimeSessionChanges } from "./session-changes.js";
import type { PluginRuntimeBase, PluginRuntimeFactory, PluginRuntime } from "./types.js";
import { PluginWorktreeValidationError } from "./worktree-errors.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../plugin-sdk/tts-runtime.js"));
const loadTtsRequestRuntime = createLazyRuntimeModule(() => import("../../tts/runtime-api.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("../../media-understanding/runtime.js"),
);
const loadGatewayPluginRuntime = createLazyRuntimeModule(
  () => import("../../gateway/server-plugins.js"),
);

function createRuntimeGateway(): PluginRuntime["gateway"] {
  return {
    isAvailable: async () => (await loadGatewayPluginRuntime()).hasInProcessGatewayContext(),
    request: async (method, params, options) => {
      const runtime = await loadGatewayPluginRuntime();
      return runtime.dispatchTrustedPluginGatewayMethod(method, params, options);
    },
    openPluginPanel: async (params) =>
      (await loadGatewayPluginRuntime()).openPluginPanelForRequester(params),
    readSessionFacts: async (params) =>
      (await loadGatewayPluginRuntime()).readTrustedPluginSessionFacts(params),
    withSessionFacts: async (select, run) =>
      (await loadGatewayPluginRuntime()).withTrustedPluginSessionFacts(select, run),
    subscribeSessionChanges: subscribeRuntimeSessionChanges,
    withUserProfileIdentity: async (params, run) => {
      const captured = {
        profileId: params.profileId,
        emails: params.emails.slice(),
        githubAccountIds:
          params.githubAccountIds === undefined ? undefined : params.githubAccountIds.slice(),
      };
      const runtime = await loadGatewayPluginRuntime();
      return runtime.withTrustedPluginUserProfileIdentity(captured, run);
    },
    resolveGitHubAccount: async ({ login, signal }) =>
      (await loadGatewayPluginRuntime()).resolveTrustedPluginGitHubAccount({ login, signal }),
  };
}

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  const bindTtsRequestRuntime = createLazyRuntimeMethodBinder(loadTtsRequestRuntime);
  return {
    buildSystemPromptHintAsync: bindTtsRuntime((runtime) => runtime.buildTtsSystemPromptHintAsync),
    prepareTtsRequest: bindTtsRequestRuntime((runtime) => runtime.prepareTtsRequest),
    textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
    textToSpeechStream: bindTtsRuntime((runtime) => runtime.textToSpeechStream),
    textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  return {
    resolveAudioInputBudget: bindMediaUnderstandingRuntime(
      (runtime) => runtime.resolveAudioInputBudget,
    ),
    runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
    describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
    describeImageFileWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.describeImageFileWithModel,
    ),
    extractStructuredWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.extractStructuredWithModel,
    ),
    describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
    transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile),
  };
}

function createRuntimeLlmFacade(getConfig: PluginRuntimeBase["getConfig"]): PluginRuntime["llm"] {
  const loadAcquireLocalService = createLazyRuntimeMethod(
    () => import("../../agents/provider-local-service.js"),
    (runtime) => runtime.createConfiguredProviderLocalServiceAcquirer(getConfig),
  );
  const loadLlm = createLazyRuntimeSurface(
    () => import("./runtime-llm.runtime.js"),
    (m) =>
      m.createRuntimeLlm({
        getConfig,
        authority: {
          allowComplete: true,
        },
      }),
  );
  return {
    acquireLocalService: loadAcquireLocalService,
    complete: createLazyRuntimeMethod(loadLlm, (llm) => llm.complete),
  };
}

function createUnavailableManagedRunsRuntime(): PluginRuntime["managedRuns"] {
  const unavailable = () => {
    throw new Error("Plugin managed runs are only available through a bound plugin registry runtime.");
  };
  return {
    admit: unavailable,
    find: unavailable,
    inspect: unavailable,
    cancel: unavailable,
    admitVerifier: unavailable,
    inspectVerifier: unavailable,
    cancelVerifier: unavailable,
  };
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new RequestScopedSubagentRuntimeError();
  };
  return {
    complete: unavailable,
    forkSession: unavailable,
    run: unavailable,
    waitForRun: unavailable,
    abortManagedRun: unavailable,
    getSessionMessages: unavailable,
    deleteSession: unavailable,
  };
}

function createUnavailableNodesRuntime(): PluginRuntime["nodes"] {
  const unavailable = () => {
    throw new Error("Plugin node runtime is only available inside the Gateway.");
  };
  return {
    list: unavailable,
    invoke: unavailable,
    openDuplex: unavailable,
  };
}

function createRuntimeWorktrees(): PluginRuntime["worktrees"] {
  const loadService = () => import("../../agents/worktrees/service.js");
  type ExactWorktreeTarget = Parameters<PluginRuntime["worktrees"]["releaseExact"]>[0];
  type RegistryRecord = Awaited<
    ReturnType<
      import("../../agents/worktrees/service.js").ManagedWorktreeService["listRegistryRecords"]
    >
  >[number];
  const exactWorktreeMatches = (record: RegistryRecord, params: ExactWorktreeTarget) =>
    record.id === params.id &&
    record.path === params.path &&
    record.branch === params.branch &&
    record.repoRoot === params.repoRoot &&
    record.repoFingerprint === params.repoFingerprint &&
    record.baseRef === params.baseRef &&
    record.createdAt === params.createdAt &&
    record.ownerKind === params.ownerKind &&
    record.ownerId === params.ownerId;
  const withExactWorktree = async <T>(
    params: ExactWorktreeTarget,
    run: (service: import("../../agents/worktrees/service.js").ManagedWorktreeService) => Promise<T>,
  ): Promise<T | undefined> =>
    runWithLocalStateOwner({
      method: "worktrees.exact",
      params: {},
      target: params.path,
      onForeignOwner: "refuse",
      runLocal: async ({ env, config, assertCurrent }) => {
        const { ManagedWorktreeService } = await loadService();
        const service = new ManagedWorktreeService({ env, getConfig: () => config });
        assertCurrent();
        const record = await service.findLiveByOwner(params.ownerKind, params.ownerId);
        assertCurrent();
        if (!record || !exactWorktreeMatches(record, params)) {
          return undefined;
        }
        await service.acquire(record.id, { commitGuard: assertCurrent });
        assertCurrent();
        return await run(service);
      },
    });
  const withExactCleanup = async <T>(
    params: ExactWorktreeTarget,
    run: (service: import("../../agents/worktrees/service.js").ManagedWorktreeService) => Promise<T>,
  ): Promise<T | "already_retired" | "mismatch"> =>
    runWithLocalStateOwner({
      method: "worktrees.exactCleanup",
      params: {},
      target: params.path,
      onForeignOwner: "refuse",
      runLocal: async ({ env, config, assertCurrent }) => {
        const { ManagedWorktreeService } = await loadService();
        const service = new ManagedWorktreeService({ env, getConfig: () => config });
        assertCurrent();
        const live = await service.findLiveByOwner(params.ownerKind, params.ownerId);
        assertCurrent();
        if (live) {
          if (!exactWorktreeMatches(live, params)) {
            return "mismatch";
          }
          await service.acquire(live.id, { commitGuard: assertCurrent });
          assertCurrent();
          return await run(service);
        }
        const historical = (await service.listRegistryRecords()).find(
          (record) => record.id === params.id,
        );
        assertCurrent();
        return historical?.removedAt !== undefined && exactWorktreeMatches(historical, params)
          ? "already_retired"
          : "mismatch";
      },
    });
  return {
    async resolveCheckoutRoot(params) {
      const { findGitCheckoutRoot } = await import("../../agents/worktrees/git.js");
      return findGitCheckoutRoot(params.path) ?? undefined;
    },
    async resolveCommit(params) {
      return runWithLocalStateOwner({
        method: "worktrees.resolveCommit",
        params: {},
        target: params.repoRoot,
        onForeignOwner: "refuse",
        runLocal: async ({ assertCurrent }) => {
          const { requireGit } = await import("../../agents/worktrees/git.js");
          assertCurrent();
          const commit = await requireGit(
            params.repoRoot,
            ["rev-parse", "--verify", "--end-of-options", params.ref + "^{commit}"],
            { beforeRun: assertCurrent },
          );
          assertCurrent();
          if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
            throw new Error("Managed run base did not resolve to an exact Git commit.");
          }
          return commit;
        },
      });
    },
    async hasSelfContainedCheckoutMetadata(params) {
      const { hasSelfContainedGitMetadata } = await import("../../agents/worktrees/git.js");
      return await hasSelfContainedGitMetadata(params.path);
    },
    async create(params) {
      return runWithLocalStateOwner({
        method: "worktrees.create",
        params: {},
        target: params.repoRoot,
        onForeignOwner: "refuse",
        runLocal: async ({ env, config, signal, assertCurrent }) => {
          const { ManagedWorktreeService } = await loadService();
          const commitGuard = () => {
            assertCurrent();
            params.commitGuard?.();
          };
          commitGuard();
          const service = new ManagedWorktreeService({ env, getConfig: () => config });
          const record = await service.create({ ...params, signal, commitGuard });
          commitGuard();
          await service.acquire(record.id, { signal, commitGuard });
          const { requireGit } = await import("../../agents/worktrees/git.js");
          const baseCommit = await requireGit(record.path, [
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
          ]);
          commitGuard();
          if (params.checkoutCommit && baseCommit !== params.checkoutCommit) {
            await service.release(record.id);
            await service.removeIfLossless(record.id);
            throw new PluginWorktreeValidationError(
              "checkout_commit_mismatch",
              "Managed worktree adoption did not match the pinned checkout commit.",
            );
          }
          return {
            id: record.id,
            path: record.path,
            branch: record.branch,
            repoRoot: record.repoRoot,
            repoFingerprint: record.repoFingerprint,
            baseRef: record.baseRef,
            baseCommit,
            createdAt: record.createdAt,
          };
        },
      });
    },
    async acquire(params) {
      return (
        (await withExactWorktree(params, async (service) => {
          await service.acquire(params.id);
          return true;
        })) === true
      );
    },
    async captureGitArtifact(params) {
      const artifact = await withExactWorktree(params, async () => {
        const { requireGit, runGit } = await import("../../agents/worktrees/git.js");
        const status = await requireGit(params.path, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        if (status.length > 0) {
          throw new PluginWorktreeValidationError(
            "dirty_checkout",
            "Managed run artifact checkout is not clean; commit all output first.",
          );
        }
        const commit = await requireGit(params.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
        if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
          throw new PluginWorktreeValidationError(
            "invalid_commit",
            "Managed run output did not resolve to an exact Git commit.",
          );
        }
        const ancestry = await runGit(params.path, [
          "merge-base",
          "--is-ancestor",
          params.baseCommit,
          commit,
        ]);
        if (ancestry.termination !== "exit" || ancestry.code !== 0) {
          throw new PluginWorktreeValidationError(
            "non_descendant_commit",
            "Managed run artifact is not a descendant of its pinned base commit.",
          );
        }
        const retentionRef =
          "refs/openclaw/managed-runs/" +
          createHash("sha256")
            .update(
              [params.repoFingerprint, params.id, params.ownerKind, params.ownerId, commit].join("\0"),
            )
            .digest("hex");
        const existing = await runGit(params.repoRoot, [
          "rev-parse",
          "--verify",
          "--quiet",
          retentionRef + "^{commit}",
        ]);
        if (existing.termination === "exit" && existing.code === 0) {
          if (existing.stdout.trim() !== commit) {
            throw new PluginWorktreeValidationError(
              "identity_mismatch",
              "Managed run artifact retention ref already names another commit.",
            );
          }
        } else if (existing.termination === "exit" && existing.code === 1) {
          const created = await runGit(params.repoRoot, ["update-ref", retentionRef, commit, ""]);
          if (created.termination !== "exit" || created.code !== 0) {
            const raced = await runGit(params.repoRoot, [
              "rev-parse",
              "--verify",
              "--quiet",
              retentionRef + "^{commit}",
            ]);
            if (
              raced.termination !== "exit" ||
              raced.code !== 0 ||
              raced.stdout.trim() !== commit
            ) {
              throw new PluginWorktreeValidationError(
                "identity_mismatch",
                "Managed run artifact retention ref could not be created exactly.",
              );
            }
          }
        } else {
          throw new Error("Managed run artifact retention ref lookup failed.");
        }
        return { commit, retentionRef };
      });
      if (!artifact) {
        throw new PluginWorktreeValidationError(
          "identity_mismatch",
          "Managed run worktree owner or identity no longer matches.",
        );
      }
      return artifact;
    },
    async releaseGitArtifact(params) {
      if (
        !/^refs\/openclaw\/managed-runs\/[a-f0-9]{64}$/u.test(params.retentionRef) ||
        !/^[a-f0-9]{40,64}$/u.test(params.commit)
      ) {
        return "mismatch";
      }
      return await runWithLocalStateOwner({
        method: "worktrees.releaseGitArtifact",
        params: {},
        target: params.repoRoot,
        onForeignOwner: "refuse",
        runLocal: async ({ assertCurrent }) => {
          const { runGit } = await import("../../agents/worktrees/git.js");
          assertCurrent();
          const current = await runGit(params.repoRoot, [
            "rev-parse",
            "--verify",
            "--quiet",
            params.retentionRef + "^{commit}",
          ]);
          assertCurrent();
          if (current.termination === "exit" && current.code === 1) {
            return "already_released" as const;
          }
          if (current.termination !== "exit" || current.code !== 0) {
            throw new Error("Managed run artifact retention ref lookup failed.");
          }
          if (current.stdout.trim() !== params.commit) {
            return "mismatch" as const;
          }
          const deleted = await runGit(params.repoRoot, [
            "update-ref",
            "-d",
            params.retentionRef,
            params.commit,
          ]);
          assertCurrent();
          if (deleted.termination === "exit" && deleted.code === 0) {
            return "released" as const;
          }
          const after = await runGit(params.repoRoot, [
            "rev-parse",
            "--verify",
            "--quiet",
            params.retentionRef + "^{commit}",
          ]);
          if (after.termination === "exit" && after.code === 1) {
            return "already_released" as const;
          }
          if (after.termination !== "exit" || after.code !== 0) {
            throw new Error("Managed run artifact retention ref reconciliation failed.");
          }
          return "mismatch" as const;
        },
      });
    },
    async assertPinnedCommit(params) {
      const matched = await withExactWorktree(params, async () => {
        const { requireGit } = await import("../../agents/worktrees/git.js");
        const commit = await requireGit(params.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
        if (commit !== params.commit) {
          throw new PluginWorktreeValidationError(
            "pinned_commit_moved",
            "Managed verifier checkout moved from its immutable artifact commit.",
          );
        }
        return true;
      });
      if (!matched) {
        throw new PluginWorktreeValidationError(
          "identity_mismatch",
          "Managed verifier worktree owner or identity no longer matches.",
        );
      }
    },
    async release(params) {
      return runWithLocalStateOwner({
        method: "worktrees.release",
        params: {},
        target: params.path,
        onForeignOwner: "refuse",
        runLocal: async ({ env, config, assertCurrent }) => {
          const { ManagedWorktreeService } = await loadService();
          assertCurrent();
          await new ManagedWorktreeService({ env, getConfig: () => config }).releaseByPath(
            params.path,
            { commitGuard: assertCurrent },
          );
        },
      });
    },
    async removeIfLossless(params) {
      return runWithLocalStateOwner({
        method: "worktrees.removeIfLossless",
        params: {},
        target: params.path,
        onForeignOwner: "refuse",
        runLocal: async ({ env, config, assertCurrent }) => {
          const { ManagedWorktreeService } = await loadService();
          assertCurrent();
          return await new ManagedWorktreeService({ env, getConfig: () => config })
            .removeIfLosslessByPath(params.path, params, { commitGuard: assertCurrent });
        },
      });
    },
    async releaseExact(params) {
      return await withExactCleanup(params, async (service) => {
        await service.release(params.id);
        return "released" as const;
      });
    },
    async removeIfLosslessExact(params) {
      return await withExactCleanup(params, async (service) =>
        (await service.removeIfLossless(params.id))
          ? ("removed" as const)
          : ("retained" as const),
      );
    },
  };
}

function createRuntimeSandbox(agent: PluginRuntime["agent"]): PluginRuntime["sandbox"] {
  const readCurrentEntry = (
    params: Parameters<PluginRuntime["sandbox"]["resolveWorkspaceAuthority"]>[0],
    memory: ReturnType<typeof captureMemoryExactSessionReader>,
  ) =>
    memory
      ? memory.read(params.sessionKey, "list")
      : agent.session.getSessionEntry({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          ...(params.storePath ? { storePath: params.storePath } : {}),
        });
  const withPreparedWorkspaceAuthority: PluginRuntime["sandbox"]["withPreparedWorkspaceAuthority"] =
    async (input, run) => {
      const params = { ...input };
      const memory = captureMemoryExactSessionReader(params);
      const sessionEntry = await agent.session.getSessionEntryAsync({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(params.storePath ? { storePath: params.storePath } : {}),
      });
      const fields = [
        "sessionId",
        "lifecycleRevision",
        "sandbox",
        "sandboxMode",
        "createdActor",
        "execHost",
        "execNode",
        "model",
        "modelProvider",
        "modelOverride",
        "providerOverride",
      ] as const;
      const expected = fields.map((field) => structuredClone(sessionEntry?.[field]));
      const assertCurrent = () => {
        const current = readCurrentEntry(params, memory);
        if (fields.some((field, index) => !isDeepStrictEqual(expected[index], current?.[field]))) {
          throw new Error("Session workspace authority changed during sandbox preparation.");
        }
      };
      assertCurrent();
      const preparedRuntimeStatus = resolveSandboxRuntimeStatus({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        preparedSessionEntry: sessionEntry ?? null,
      });
      const authority = await withPreparedSessionCapabilityRead(() =>
        resolveSandboxWorkspaceAuthority({
          ...params,
          sessionEntry,
          preparedRuntimeStatus,
        }),
      );
      if (!authority.sandboxed || authority.confinementError) {
        return await run(authority);
      }
      const { resolveSandboxContext } = await import("../../agents/sandbox/context.js");
      assertCurrent();
      const sandbox = await resolveSandboxContext({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        requireCurrentConfig: true,
        preparedRuntimeStatus,
        assertCurrent,
      });
      try {
        assertCurrent();
        return await run(authority);
      } finally {
        sandbox?.[Symbol.dispose]?.();
      }
    };
  return {
    resolveWorkspaceAuthority(params) {
      const memory = captureMemoryExactSessionReader(params);
      const sessionEntry = readCurrentEntry(params, memory);
      const preparedRuntimeStatus = resolveSandboxRuntimeStatus({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        preparedSessionEntry: sessionEntry ?? null,
      });
      return resolveSandboxWorkspaceAuthority({ ...params, sessionEntry, preparedRuntimeStatus });
    },
    prepareWorkspaceAuthority: (params) =>
      withPreparedWorkspaceAuthority(params, async (authority) => authority),
    withPreparedWorkspaceAuthority,
  };
}

// Loaded by path from the plugin loader, so static export analysis cannot see this contract.
export const createPluginRuntime: PluginRuntimeFactory = (
  _options = {},
  base = createRuntimeBase(),
) => {
  const agent = createRuntimeAgent();
  let modelAuth = _options.modelAuth;
  let modelConfig = _options.modelConfig;
  const runtime: PluginRuntime = {
    version: VERSION,
    capabilities: base.capabilities,
    decisions: {
      evaluate: async (...args) =>
        (await import("../../decisions/runtime.js")).evaluateDecision(...args),
    },
    gateway: _options.gateway ?? createRuntimeGateway(),
    config: base.config,
    agent,
    hooks: _options.hooks ?? {
      dispatchHookAgentTurn: async () => {
        throw new Error("Plugin hook runtime is only available inside the Gateway.");
      },
    },
    managedRuns: createUnavailableManagedRunsRuntime(),
    subagent: _options.subagent ?? createUnavailableSubagentRuntime(),
    nodes: _options.nodes ?? createUnavailableNodesRuntime(),
    sandbox: createRuntimeSandbox(agent),
    worktrees: createRuntimeWorktrees(),
    system: base.system,
    media: createRuntimeMedia(),
    webSearch: {
      listProviders: (params) => {
        warnPluginSdkDeprecation({
          family: "web-search-providers",
          method: "runtime.webSearch.listProviders",
          replacement: "runtime.webSearch.listProvidersAsync",
        });
        return listWebSearchProviders(params);
      },
      listProvidersAsync: listWebSearchProvidersAsync,
      search: runWebSearch,
    },
    channel: createRuntimeChannel(
      _options.dispatchReplyFromConfig
        ? { dispatchReplyFromConfig: _options.dispatchReplyFromConfig }
        : undefined,
    ),
    events: { onAgentEvent, onSessionTranscriptUpdate },
    logging: createRuntimeLogging(),
    state: base.state,

    tts: createRuntimeTts(),
    mediaUnderstanding: createRuntimeMediaUnderstandingFacade(),
    get modelAuth() {
      return (modelAuth ??= resolveNativePluginModelAuth());
    },
    get modelConfig() {
      return (modelConfig ??= resolveNativePluginModelConfig());
    },
    // Listings stay synchronous; execution loads only when requested.
    imageGeneration: {
      generate: async (params) =>
        (await import("../../image-generation/runtime.js")).generateImage(params),
      listProviders: (params) => listImageGenerationProviders(params?.config),
    },
    videoGeneration: {
      generate: async (params) =>
        (await import("../../video-generation/runtime.js")).generateVideo(params),
      listProviders: (params) => listVideoGenerationProviders(params?.config),
    },
    musicGeneration: {
      generate: async (params) =>
        (await import("../../music-generation/runtime.js")).generateMusic(params),
      listProviders: (params) => listMusicGenerationProviders(params?.config),
    },
    llm: createRuntimeLlmFacade(base.getConfig),
  };
  // SDK consumers retain these getter-only descriptors after lazy runtime materialization.
  for (const key of [
    "tts",
    "mediaUnderstanding",
    "imageGeneration",
    "videoGeneration",
    "musicGeneration",
    "llm",
  ] as const) {
    const value = runtime[key];
    Object.defineProperty(runtime, key, { get: () => value });
  }
  return runtime;
};

export type { PluginRuntime } from "./types.js";
