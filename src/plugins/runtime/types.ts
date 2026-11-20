// Plugin runtime types describe activated plugin capabilities exposed to core execution.
// Owner schema module import keeps the ProtocolSchemas registry out of the
// public plugin-sdk dts graph (check-plugin-sdk-exports guards this).
import type { NodePluginToolDescriptor } from "../../../packages/gateway-protocol/src/schema/nodes.js";
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OperatorScope } from "../../gateway/operator-scopes.js";
import type { LlmCompleteUsage, PluginRuntimeCore, RuntimeLogger } from "./types-core.js";
import type { PluginRuntimeManagedRuns } from "./types-managed-runs.js";
import type {
  RuntimeSessionFactsResult,
  RuntimeSessionFactsSelection,
  RuntimeSessionFactsSelectionResult,
} from "./types-session-facts.js";

export type { RuntimeLogger };
export type * from "./types-managed-runs.js";

type PluginRuntimeChannel = import("./types-channel.js").PluginRuntimeChannel;

// ── Subagent runtime types ──────────────────────────────────────────

type SubagentRunParams = {
  /** Revalidate command authority at the host's run admission boundary. */
  assertCurrent?: () => void;
  sessionKey: string;
  message: string;
  /** Run with an exact empty tool surface. */
  disableTools?: boolean;
  /** Add exact tools registered by the calling plugin to the worker's normal tool surface. */
  toolsAlsoAllow?: string[];
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  /** Use the bounded subagent prompt instead of the full conversation prompt. */
  promptMode?: "minimal";
  lane?: string;
  lightContext?: boolean;
  deliver?: boolean;
  /** Deliver the completion to the authenticated requester of the current hook invocation. */
  completionDelivery?: "current-requester";
  idempotencyKey?: string;
  cwd?: string;
  /** Host-only durable admission binding used by the managed-run facade. */
  managedRun?: {
    version: 1;
    runId: string;
    requestFingerprint: string;
  };
};

type SubagentCompleteParams = {
  agentId: string;
  message: string;
  extraSystemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type PluginManagedWorktree = {
  id: string;
  path: string;
  branch: string;
  repoRoot: string;
  repoFingerprint: string;
  baseRef: string;
  baseCommit: string;
  createdAt: number;
};

type PluginManagedWorktreeOwner = {
  ownerKind: "workboard";
  ownerId: string;
};

type PluginManagedWorktreeTarget = PluginManagedWorktree & PluginManagedWorktreeOwner;

type PluginManagedWorktreeReleaseResult = "released" | "already_retired" | "mismatch";

type PluginManagedWorktreeRemovalResult = "removed" | "already_retired" | "retained" | "mismatch";

type SubagentRunResult = {
  runId: string;
  /** Canonical accepted session identity. Optional for explicit/custom runtimes. */
  sessionKey?: string;
  runtime?: {
    harness: string;
    provider: string;
    model: string;
  };
};

type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

type SubagentAbortManagedRunParams = {
  runId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  requestFingerprint: string;
};

type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

type RuntimeNodeListParams = {
  connected?: boolean;
};

type RuntimeNodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    platform?: string;
    clientId?: string;
    remoteIp?: string;
    connected?: boolean;
    connectedAtMs?: number;
    lastSeenAtMs?: number;
    caps?: string[];
    commands?: string[];
    /** True only for the node host installed alongside this Gateway. */
    gatewayLocal?: boolean;
    /** Advertised commands currently permitted by Gateway node-command policy. */
    invocableCommands?: string[];
    nodePluginTools?: NodePluginToolDescriptor[];
  }>;
};

type RuntimeNodeInvokeParams = {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  sessionKey?: string;
  /** Cancel the invocation and any work already dispatched to a first-party node. */
  signal?: AbortSignal;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
};

/** A lifecycle-bound, complete-message binary channel for one node invocation. */
type RuntimeNodeDuplexChannel = {
  send: (message: Uint8Array) => Promise<void>;
  onMessage: (listener: (message: Uint8Array) => void | Promise<void>) => () => void;
  closed: Promise<unknown>;
  close: () => void;
};

export type RuntimeGatewayRequestOptions = {
  timeoutMs?: number;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
  /** Fence an in-process channel send to the exact current requester session incarnation. */
  sessionDeliveryGeneration?: {
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
};

/** Trusted in-process runtime surface injected into native plugins. */
export type PluginRuntime = PluginRuntimeCore & {
  gateway: {
    /** Whether this process owns an active Gateway request context. */
    isAvailable: () => Promise<boolean>;
    /** Dispatch a Gateway method as the current trusted plugin. */
    request: <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: RuntimeGatewayRequestOptions,
    ) => Promise<T>;
    /** Open this plugin's native panel in the requesting Control UI, preserving caller authority. */
    openPluginPanel: (params: {
      panelId: string;
      sessionKey: string;
      agentId?: string;
    }) => Promise<{ ok: true }>;
    /** Bounded redacted facts for up to 40 sessions; excludes incognito and rechecks the bound caller/lifecycle. */
    readSessionFacts: (params: {
      sessionKeys: readonly string[];
    }) => Promise<RuntimeSessionFactsResult>;
    /** Select immutable current session facts, retaining caller authority through the consumer. */
    withSessionFacts: <T>(
      select: RuntimeSessionFactsSelection,
      run: (snapshot: RuntimeSessionFactsSelectionResult) => Promise<T>,
    ) => Promise<T>;
    /** Keyed fact invalidations; callers own unsubscribe. Broad store changes are excluded. */
    subscribeSessionChanges: (
      listener: (event: { agentId: string; sessionKey: string; factsInvalidated?: string }) => void,
    ) => () => void;
    withUserProfileIdentity?: <T>(
      params: {
        profileId: string;
        emails: readonly string[];
        githubAccountIds?: readonly number[];
      },
      run: (assertCurrent: () => void) => Promise<T>,
    ) => Promise<T>;
    /** Resolve public GitHub identity with the Gateway credential; never retry anonymously. */
    resolveGitHubAccount?: (params: { login: string; signal?: AbortSignal }) => Promise<
      | { accountId: number; login: string; error?: never }
      | {
          error: {
            statusCode: number;
            message: string;
            retryAtMs?: number;
            credentialConfigured: boolean;
          };
        }
    >;
  };
  /** Operator-gated, plugin-owned, version-pinned worktree runs. */
  managedRuns: PluginRuntimeManagedRuns;
  subagent: {
    /** Fresh, tool-free background inference under the existing subagent model policy. */
    complete: (params: SubagentCompleteParams) => Promise<{ text: string }>;
    /** Ephemeral session-context inference on the session's model, with tool execution denied. */
    forkSession: (params: {
      sessionKey: string;
      message: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    }) => Promise<{ text: string; usage?: LlmCompleteUsage }>;
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<AgentWaitResult>;
    /** Abort only the exact plugin-owned managed-run session incarnation. */
    abortManagedRun: (params: SubagentAbortManagedRunParams) => Promise<{ aborted: boolean }>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  nodes: {
    list: (params?: RuntimeNodeListParams) => Promise<RuntimeNodeListResult>;
    invoke: (params: RuntimeNodeInvokeParams) => Promise<unknown>;
    /** Open a connection-scoped binary node command inside the trusted Gateway runtime. */
    openDuplex: (
      params: RuntimeNodeInvokeParams & {
        maxMessageBytes?: number;
        maxOutstandingDeliveryBytes?: number;
      },
    ) => Promise<RuntimeNodeDuplexChannel>;
  };
  sandbox: {
    resolveWorkspaceAuthority: (params: {
      config: OpenClawConfig;
      agentId?: string;
      storePath?: string;
      confinedToolNames?: readonly string[];
      requiredToolNames?: readonly string[];
      modelProvider?: string;
      modelId?: string;
      sessionKey: string;
    }) => {
      sandboxed: boolean;
      workspaceAccess: "none" | "ro" | "rw";
      confinementError?: string;
    };
    prepareWorkspaceAuthority: (
      params: Parameters<PluginRuntime["sandbox"]["resolveWorkspaceAuthority"]>[0] & {
        workspaceDir: string;
      },
    ) => Promise<ReturnType<PluginRuntime["sandbox"]["resolveWorkspaceAuthority"]>>;
    /** Hold the prepared sandbox/workspace binding through the actual run admission callback. */
    withPreparedWorkspaceAuthority: <T>(
      params: Parameters<PluginRuntime["sandbox"]["prepareWorkspaceAuthority"]>[0],
      run: (
        authority: ReturnType<PluginRuntime["sandbox"]["resolveWorkspaceAuthority"]>,
      ) => Promise<T>,
    ) => Promise<T>;
  };
  worktrees: {
    resolveCheckoutRoot: (params: { path: string }) => Promise<string | undefined>;
    resolveCommit: (params: { repoRoot: string; ref: string }) => Promise<string>;
    hasSelfContainedCheckoutMetadata?: (params: { path: string }) => Promise<boolean>;
    create: (params: {
      repoRoot: string;
      name: string;
      baseRef?: string;
      checkoutCommit?: string;
      ownerKind: "workboard";
      ownerId: string;
      commitGuard?: () => void;
    }) => Promise<PluginManagedWorktree>;
    /** Reacquire a durable registry lease only when the exact owner and identity still match. */
    acquire: (params: PluginManagedWorktreeTarget) => Promise<boolean>;
    /** Inspect a clean descendant commit from the exact managed checkout. */
    captureGitArtifact: (
      params: PluginManagedWorktreeTarget & { baseCommit: string },
    ) => Promise<{ commit: string; retentionRef: string }>;
    /** Release the dedicated reachability ref only when it still names the exact artifact. */
    releaseGitArtifact: (params: {
      repoRoot: string;
      retentionRef: string;
      commit: string;
    }) => Promise<"released" | "already_released" | "mismatch">;
    /** Require the exact managed checkout to still point at the immutable verifier commit. */
    assertPinnedCommit: (params: PluginManagedWorktreeTarget & { commit: string }) => Promise<void>;
    /** Legacy path release retained for existing plugin callers. */
    release: (params: { path: string }) => Promise<void>;
    /** Legacy owner-fenced path cleanup retained for existing plugin callers. */
    removeIfLossless: (params: { path: string } & PluginManagedWorktreeOwner) => Promise<boolean>;
    /** Idempotent cleanup fenced to the complete durable worktree incarnation. */
    releaseExact: (
      params: PluginManagedWorktreeTarget,
    ) => Promise<PluginManagedWorktreeReleaseResult>;
    /** Exact lossless cleanup that distinguishes retirement from replacement. */
    removeIfLosslessExact: (
      params: PluginManagedWorktreeTarget,
    ) => Promise<PluginManagedWorktreeRemovalResult>;
  };
  channel: PluginRuntimeChannel;
};

export type CreatePluginRuntimeOptions = {
  dispatchReplyFromConfig?: PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"];
  gateway?: PluginRuntime["gateway"];
  hooks?: PluginRuntime["hooks"];
  subagent?: PluginRuntime["subagent"];
  nodes?: PluginRuntime["nodes"];
  /** Native policy facades avoid re-evaluating SDK dependencies during registration. */
  modelAuth?: PluginRuntime["modelAuth"];
  modelConfig?: PluginRuntime["modelConfig"];
  allowGatewaySubagentBinding?: boolean;
};

/** Private host bindings retained by the path-loaded runtime, not exposed to plugins. */
export type PluginRuntimeBase = Pick<
  PluginRuntime,
  "capabilities" | "config" | "state" | "system"
> & {
  getConfig: () => OpenClawConfig;
};

/** Checked contract for both the path-loaded factory and its implementation. */
export type PluginRuntimeFactory = (
  options?: CreatePluginRuntimeOptions,
  base?: PluginRuntimeBase,
) => PluginRuntime;
