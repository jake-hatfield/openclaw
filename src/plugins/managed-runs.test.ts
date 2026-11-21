import { describe, expect, it, vi } from "vitest";
import { PluginSubagentAdmissionError } from "../plugin-sdk/error-runtime.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import { createPluginManagedRunsRuntime } from "./managed-runs.js";
import type { ManagedRunRecord } from "./runtime/types-managed-runs.js";
import type { PluginRuntime } from "./runtime/types.js";
import { PluginWorktreeValidationError } from "./runtime/worktree-errors.js";

const BASE_COMMIT = "1".repeat(40);
const ARTIFACT_COMMIT = "2".repeat(40);
const ARTIFACT_REF = "refs/openclaw/managed-runs/" + "3".repeat(64);

function createStore() {
  const values = new Map<string, ManagedRunRecord>();
  let revision = 0;
  const store = {
    lookup: vi.fn(async (key: string) => structuredClone(values.get(key))),
    registerIfAbsent: vi.fn(async (key: string, value: ManagedRunRecord) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, structuredClone(value));
      revision += 1;
      return true;
    }),
    observe: vi.fn(async (key: string) => ({
      value: structuredClone(values.get(key)),
      comparison: String(revision),
    })),
    compareAndApply: vi.fn(
      async (
        key: string,
        comparison: string,
        intent: { operation: "update"; action: "set"; value: ManagedRunRecord },
      ) => {
        const assertJsonSafe = (value: unknown, path = "$"): void => {
          if (value === undefined) {
            throw new Error("undefined plugin state at " + path);
          }
          if (Array.isArray(value)) {
            value.forEach((entry, index) => assertJsonSafe(entry, path + "[" + index + "]"));
            return;
          }
          if (value && typeof value === "object") {
            for (const [property, entry] of Object.entries(value)) {
              assertJsonSafe(entry, path + "." + property);
            }
          }
        };
        assertJsonSafe(intent.value);
        if (comparison !== String(revision)) {
          return {
            status: "conflict" as const,
            current: { value: values.get(key), comparison: String(revision) },
          };
        }
        values.set(key, structuredClone(intent.value));
        revision += 1;
        return { status: "applied" as const };
      },
    ),
  };
  return {
    values,
    store: store as unknown as PluginStateKeyedStore<ManagedRunRecord, 2>,
  };
}

type SessionIdentity = {
  sessionId: string;
  lifecycleRevision?: string;
  pluginOwnerId: string;
  modelSelectionLocked: boolean;
  pluginManagedRun?: {
    version: 1;
    pluginId: string;
    runId: string;
    requestFingerprint: string;
    acceptedAt?: number;
  };
};

function createFixture(options?: {
  state?: ReturnType<typeof createStore>;
  verifierAccess?: "ro" | "rw";
}) {
  const state = options?.state ?? createStore();
  let clock = 1_000;
  let authorityHeld = false;
  const sessions = new Map<string, SessionIdentity>();
  const config = {
    plugins: {
      entries: {
        "example-plugin": {
          managedRuns: {
            enabled: true,
            agentAllowlist: ["worker"],
            verifierAgentAllowlist: ["reviewer"],
            projects: [
              { projectId: "openclaw", repoRoot: "/repo/openclaw", baseRefs: ["refs/heads/main"] },
            ],
          },
        },
      },
    },
  };
  const createWorktree = vi.fn(
    async (params: { name: string; baseRef?: string; checkoutCommit?: string }) => ({
      id: "wt-" + params.name,
      path: "/worktrees/" + params.name,
      branch: params.name,
      repoRoot: "/repo/openclaw",
      repoFingerprint: "repo-fingerprint",
      baseRef: params.baseRef ?? "HEAD",
      baseCommit: params.checkoutCommit ?? BASE_COMMIT,
      createdAt: 500,
    }),
  );
  const run = vi.fn(
    async (params: {
      sessionKey: string;
      idempotencyKey?: string;
      message: string;
      cwd?: string;
      assertCurrent?: () => void;
      managedRun?: { version: 1; runId: string; requestFingerprint: string };
    }) => {
      expect(authorityHeld).toBe(true);
      params.assertCurrent?.();
      sessions.set(params.sessionKey, {
        sessionId: "session-" + params.sessionKey,
        lifecycleRevision: "lifecycle-" + params.sessionKey,
        pluginOwnerId: "example-plugin",
        modelSelectionLocked: true,
        ...(params.managedRun
          ? {
              pluginManagedRun: {
                ...params.managedRun,
                pluginId: "example-plugin",
                acceptedAt: clock,
              },
            }
          : {}),
      });
      return { runId: params.idempotencyKey!, sessionKey: params.sessionKey };
    },
  );
  const captureGitArtifact = vi.fn(async () => ({
    commit: ARTIFACT_COMMIT,
    retentionRef: ARTIFACT_REF,
  }));
  const releaseGitArtifact = vi.fn<PluginRuntime["worktrees"]["releaseGitArtifact"]>(
    async () => "released",
  );
  const release = vi.fn<PluginRuntime["worktrees"]["releaseExact"]>(async () => "released");
  const waitForRun = vi.fn<PluginRuntime["subagent"]["waitForRun"]>(async () => ({ status: "ok" }));
  const gatewayRequest = vi.fn(async () => ({ aborted: true }));
  const abortManagedRun = vi.fn<PluginRuntime["subagent"]["abortManagedRun"]>(async () => ({
    aborted: true,
  }));
  const withPreparedWorkspaceAuthority = vi.fn(
    async (
      params: { agentId?: string },
      callback: (authority: {
        sandboxed: boolean;
        workspaceAccess: "ro" | "rw";
      }) => Promise<unknown>,
    ) => {
      authorityHeld = true;
      try {
        return await callback({
          sandboxed: true,
          workspaceAccess: params.agentId === "reviewer" ? (options?.verifierAccess ?? "ro") : "rw",
        });
      } finally {
        authorityHeld = false;
      }
    },
  );
  const runtime = {
    config: { current: vi.fn(() => structuredClone(config)) },
    worktrees: {
      resolveCommit: vi.fn(async () => BASE_COMMIT),
      create: createWorktree,
      acquire: vi.fn(async () => true),
      captureGitArtifact,
      releaseGitArtifact,
      assertPinnedCommit: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      removeIfLossless: vi.fn(async () => true),
      releaseExact: release,
      removeIfLosslessExact: vi.fn(async () => "removed" as const),
    },
    sandbox: {
      resolveWorkspaceAuthority: vi.fn((params: { agentId?: string }) => ({
        sandboxed: true,
        workspaceAccess: params.agentId === "reviewer" ? (options?.verifierAccess ?? "ro") : "rw",
      })),
      withPreparedWorkspaceAuthority,
    },
    subagent: {
      run,
      waitForRun,
      abortManagedRun,
      getSessionMessages: vi.fn(async (params: { sessionKey: string }) => ({
        messages: [{ role: "assistant", text: "result for " + params.sessionKey }],
      })),
    },
    agent: {
      session: {
        getSessionEntryAsync: vi.fn(async (params: { sessionKey: string }) =>
          structuredClone(sessions.get(params.sessionKey)),
        ),
      },
    },
    gateway: { request: gatewayRequest },
  } as unknown as Pick<
    PluginRuntime,
    "agent" | "config" | "gateway" | "sandbox" | "subagent" | "worktrees"
  >;
  const assertCurrent = vi.fn();
  const createManaged = () =>
    createPluginManagedRunsRuntime({
      pluginId: "example-plugin",
      runtime,
      store: state.store,
      assertCurrent,
      now: () => ++clock,
    });
  return {
    ...state,
    managed: createManaged(),
    createManaged,
    runtime,
    sessions,
    assertCurrent,
    createWorktree,
    run,
    captureGitArtifact,
    releaseGitArtifact,
    release,
    waitForRun,
    gatewayRequest,
    abortManagedRun,
    withPreparedWorkspaceAuthority,
  };
}

const workerRequest = {
  key: "issue-42",
  projectId: "openclaw",
  agentId: "worker",
  baseRef: "refs/heads/main",
  message: "Implement the pinned change",
};

async function completeWorker(fixture: ReturnType<typeof createFixture>) {
  await fixture.managed.admit(workerRequest);
  return await fixture.managed.inspect({ key: workerRequest.key });
}

describe("plugin managed runs", () => {
  it("pins the base commit before admission and binds authority through deterministic dispatch", async () => {
    const fixture = createFixture();
    const admitted = await fixture.managed.admit(workerRequest);

    expect(admitted).toMatchObject({
      pluginId: "example-plugin",
      baseRef: "refs/heads/main",
      baseCommit: BASE_COMMIT,
      status: "running",
      admission: {
        requestFingerprint: admitted.requestFingerprint,
        runId: admitted.execution?.runId,
      },
      execution: { agentId: "worker" },
    });
    expect(
      vi.mocked(fixture.runtime.worktrees.resolveCommit).mock.invocationCallOrder[0]!,
    ).toBeLessThan(fixture.createWorktree.mock.invocationCallOrder[0]!);
    expect(fixture.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ baseRef: "refs/heads/main", checkoutCommit: BASE_COMMIT }),
    );
    expect(fixture.run).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: admitted.execution?.runId,
      }),
    );
    expect(admitted.execution?.sessionKey).toBe("agent:worker:subagent:" + admitted.taskName);
  });

  it("binds sandboxed worker and verifier execution through prepared workspaces without cwd overrides", async () => {
    const fixture = createFixture();
    const worker = await fixture.managed.admit(workerRequest);

    expect(fixture.withPreparedWorkspaceAuthority).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: "worker",
        sessionKey: worker.execution?.sessionKey,
        workspaceDir: worker.worktree?.path,
      }),
      expect.any(Function),
    );
    expect(fixture.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionKey: worker.execution?.sessionKey,
        idempotencyKey: worker.execution?.runId,
      }),
    );
    expect(fixture.run.mock.calls[0]?.[0]).not.toHaveProperty("cwd");

    await fixture.managed.inspect({ key: workerRequest.key });
    const verified = await fixture.managed.admitVerifier({
      key: workerRequest.key,
      agentId: "reviewer",
      message: "Verify the exact artifact",
    });
    expect(fixture.withPreparedWorkspaceAuthority).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: "reviewer",
        sessionKey: verified.verifier?.execution?.sessionKey,
        workspaceDir: verified.verifier?.worktree?.path,
      }),
      expect.any(Function),
    );
    expect(fixture.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: verified.verifier?.execution?.sessionKey,
        idempotencyKey: verified.verifier?.execution?.runId,
      }),
    );
    expect(fixture.run.mock.calls[1]?.[0]).not.toHaveProperty("cwd");
  });

  it("captures a host-inspected immutable artifact and verifies exactly that commit read-only", async () => {
    const fixture = createFixture();
    const completed = await completeWorker(fixture);

    expect(completed).toMatchObject({
      status: "succeeded",
      artifact: {
        kind: "git_commit",
        commit: ARTIFACT_COMMIT,
        baseCommit: BASE_COMMIT,
        worktreeId: completed.worktree?.id,
      },
      lease: { status: "released" },
      artifactRetention: { status: "retained" },
    });
    expect(fixture.releaseGitArtifact).not.toHaveBeenCalled();
    const verifying = await fixture.managed.admitVerifier({
      key: workerRequest.key,
      agentId: "reviewer",
      message: "Verify the exact artifact",
    });
    expect(fixture.createWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseRef: ARTIFACT_COMMIT,
        checkoutCommit: ARTIFACT_COMMIT,
      }),
    );
    expect(verifying.verifier).toMatchObject({
      status: "running",
      artifact: { commit: ARTIFACT_COMMIT },
    });
    expect(fixture.run.mock.calls.at(-1)?.[0]?.message).toContain(ARTIFACT_COMMIT);
    expect(fixture.releaseGitArtifact).not.toHaveBeenCalled();
    const verified = await fixture.managed.inspectVerifier({ key: workerRequest.key });
    expect(verified.verifier).toMatchObject({
      status: "succeeded",
      lease: { status: "released" },
    });
    expect(verified.artifactRetention).toMatchObject({ status: "released" });
    expect(fixture.releaseGitArtifact).toHaveBeenCalledWith({
      repoRoot: "/repo/openclaw",
      retentionRef: ARTIFACT_REF,
      commit: ARTIFACT_COMMIT,
    });
  });

  it("does not delete a replacement artifact ref during verifier cleanup", async () => {
    const fixture = createFixture();
    await completeWorker(fixture);
    await fixture.managed.admitVerifier({
      key: workerRequest.key,
      agentId: "reviewer",
      message: "Verify safely",
    });
    fixture.releaseGitArtifact.mockResolvedValueOnce("mismatch");

    const verified = await fixture.managed.inspectVerifier({ key: workerRequest.key });
    expect(verified.verifier).toMatchObject({ status: "succeeded", lease: { status: "released" } });
    expect(verified.artifactRetention).toMatchObject({
      status: "retained",
      error: expect.stringContaining("replacement was not touched"),
    });
  });

  it("recovers an uncertain worktree creation by adopting only the deterministic owner", async () => {
    const fixture = createFixture();
    fixture.createWorktree.mockRejectedValueOnce(
      Object.assign(new Error("creation reply lost"), { code: "outcome-unknown" }),
    );

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "worktree creation outcome is uncertain",
    );
    expect((await fixture.managed.find({ key: workerRequest.key }))?.status).toBe(
      "admission_uncertain",
    );
    expect(fixture.run).not.toHaveBeenCalled();

    const recovered = await fixture.createManaged().admit(workerRequest);
    expect(recovered.status).toBe("running");
    expect(fixture.createWorktree).toHaveBeenCalledTimes(2);
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost worker response after restart without another dispatch", async () => {
    const fixture = createFixture();
    fixture.run.mockImplementationOnce(async (params) => {
      fixture.sessions.set(params.sessionKey, {
        sessionId: "accepted-session",
        lifecycleRevision: "accepted-generation",
        pluginOwnerId: "example-plugin",
        modelSelectionLocked: true,
        pluginManagedRun: {
          ...params.managedRun!,
          pluginId: "example-plugin",
          acceptedAt: 1_001,
        },
      });
      throw new Error("response lost after acceptance");
    });

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "admission outcome is uncertain",
    );
    expect((await fixture.managed.find({ key: workerRequest.key }))?.status).toBe(
      "admission_uncertain",
    );

    const recovered = await fixture.createManaged().admit(workerRequest);
    expect(recovered).toMatchObject({
      status: "running",
      execution: {
        sessionId: "accepted-session",
        lifecycleRevision: "accepted-generation",
      },
    });
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("retires an interrupted accepted run whose durable session omitted lifecycle identity", async () => {
    const fixture = createFixture();
    fixture.run.mockImplementationOnce(async (params) => {
      fixture.sessions.set(params.sessionKey, {
        sessionId: "accepted-without-revision",
        pluginOwnerId: "example-plugin",
        modelSelectionLocked: true,
        pluginManagedRun: {
          ...params.managedRun!,
          pluginId: "example-plugin",
          acceptedAt: 1_001,
        },
      });
      throw new Error("host crashed after durable acceptance");
    });
    fixture.waitForRun.mockResolvedValueOnce({
      status: "error",
      error: "interrupted by Gateway restart",
    });

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "admission outcome is uncertain",
    );
    const retired = await fixture.createManaged().admit(workerRequest);

    expect(retired).toMatchObject({
      status: "failed",
      lease: { status: "released" },
      error: expect.stringContaining("did not publish lifecycleRevision"),
    });
    expect(retired).not.toHaveProperty("execution");
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(fixture.abortManagedRun).not.toHaveBeenCalled();
  });

  it("keeps a missing-revision admission ambiguous while the exact run is not terminal", async () => {
    const fixture = createFixture();
    fixture.run.mockImplementationOnce(async (params) => {
      fixture.sessions.set(params.sessionKey, {
        sessionId: "accepted-without-revision",
        pluginOwnerId: "example-plugin",
        modelSelectionLocked: true,
        pluginManagedRun: {
          ...params.managedRun!,
          pluginId: "example-plugin",
          acceptedAt: 1_001,
        },
      });
      throw new Error("response lost");
    });
    fixture.waitForRun.mockResolvedValueOnce({ status: "pending" });

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "admission outcome is uncertain",
    );
    await expect(fixture.createManaged().admit(workerRequest)).rejects.toThrow(
      "has no lifecycleRevision and is not terminal",
    );
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("does not retire a replaced or foreign session as the accepted run", async () => {
    const fixture = createFixture();
    fixture.run.mockImplementationOnce(async (params) => {
      fixture.sessions.set(params.sessionKey, {
        sessionId: "accepted-session",
        lifecycleRevision: "accepted-revision",
        pluginOwnerId: "example-plugin",
        modelSelectionLocked: true,
        pluginManagedRun: {
          ...params.managedRun!,
          pluginId: "example-plugin",
          acceptedAt: 1_001,
        },
      });
      throw new Error("response lost");
    });

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "admission outcome is uncertain",
    );
    const plan = (await fixture.managed.find({ key: workerRequest.key }))!.admission!;
    fixture.sessions.set(plan.sessionKey, {
      sessionId: "replacement-session",
      pluginOwnerId: "other-plugin",
      modelSelectionLocked: true,
    });

    await expect(fixture.createManaged().admit(workerRequest)).rejects.toThrow(
      "ownership collision",
    );
    expect(fixture.waitForRun).not.toHaveBeenCalled();
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("replays the exact accepted run after the retired sandbox cwd preflight failure", async () => {
    const fixture = createFixture();
    fixture.run.mockImplementationOnce(async (params) => {
      fixture.sessions.set(params.sessionKey, {
        sessionId: "accepted-preflight-session",
        lifecycleRevision: "accepted-preflight-generation",
        pluginOwnerId: "example-plugin",
        modelSelectionLocked: true,
        pluginManagedRun: {
          version: 1,
          pluginId: "example-plugin",
          runId: params.idempotencyKey!,
          requestFingerprint: params.managedRun!.requestFingerprint,
          acceptedAt: 1,
        },
      });
      throw new Error(
        "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
      );
    });
    fixture.waitForRun.mockResolvedValueOnce({
      status: "error",
      error:
        "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
    });

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "admission outcome is uncertain",
    );
    const recovered = await fixture.createManaged().admit(workerRequest);
    expect(recovered.status).toBe("running");
    expect(recovered.execution?.sessionId).toBe(
      fixture.sessions.get(recovered.admission!.sessionKey)?.sessionId,
    );
    expect(recovered.execution?.sessionId).not.toBe("accepted-preflight-session");
    expect(fixture.run).toHaveBeenCalledTimes(2);
    expect(fixture.run.mock.calls[1]?.[0]).not.toHaveProperty("cwd");
  });

  it("never retries an uncertain admission when no exact accepted session can be proven", async () => {
    const fixture = createFixture();
    fixture.run.mockRejectedValueOnce(new Error("transport lost before proof"));

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "admission outcome is uncertain",
    );
    await expect(fixture.createManaged().admit(workerRequest)).rejects.toThrow(
      "no second worker was dispatched",
    );
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("retries a proven pre-dispatch authority refusal with the same retained checkout", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.runtime.worktrees.removeIfLosslessExact).mockResolvedValueOnce("retained");
    fixture.withPreparedWorkspaceAuthority.mockImplementationOnce(
      async (_params, callback) =>
        await callback({ sandboxed: true, workspaceAccess: "none" } as never),
    );

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "requires exact rw workspace authority",
    );
    expect(await fixture.managed.find({ key: workerRequest.key })).toMatchObject({
      status: "failed",
      lease: { status: "retained" },
    });
    expect(fixture.run).not.toHaveBeenCalled();

    await expect(fixture.managed.admit(workerRequest)).resolves.toMatchObject({
      status: "running",
    });
    expect(fixture.createWorktree).toHaveBeenCalledOnce();
    expect(fixture.runtime.worktrees.acquire).toHaveBeenCalledOnce();
    expect(fixture.run).toHaveBeenCalledOnce();
  });

  it("does not retry a definitive host admission refusal after dispatch was attempted", async () => {
    const fixture = createFixture();
    fixture.run.mockRejectedValueOnce(
      new PluginSubagentAdmissionError("refused", "session fingerprint collision"),
    );

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "session fingerprint collision",
    );
    await expect(fixture.createManaged().admit(workerRequest)).resolves.toMatchObject({
      status: "failed",
    });
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign plugin session ownership collision", async () => {
    const fixture = createFixture();
    fixture.run.mockImplementationOnce(async (params) => {
      fixture.sessions.set(params.sessionKey, {
        sessionId: "foreign-session",
        lifecycleRevision: "foreign-generation",
        pluginOwnerId: "other-plugin",
        modelSelectionLocked: true,
      });
      return { runId: params.idempotencyKey!, sessionKey: params.sessionKey };
    });

    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow(
      "admission outcome is uncertain",
    );
    await expect(fixture.managed.admit(workerRequest)).rejects.toThrow("ownership collision");
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("fences worker cancellation to the exact session incarnation", async () => {
    const fixture = createFixture();
    const admitted = await fixture.managed.admit(workerRequest);
    fixture.sessions.set(admitted.execution!.sessionKey, {
      sessionId: "replacement-session",
      lifecycleRevision: "replacement-generation",
      pluginOwnerId: "example-plugin",
      modelSelectionLocked: true,
    });

    await expect(fixture.managed.cancel({ key: workerRequest.key })).rejects.toThrow(
      "lifecycle or plugin ownership no longer matches",
    );
    expect(fixture.abortManagedRun).not.toHaveBeenCalled();
  });

  it("recovers an uncertain exact-run cancellation after restart", async () => {
    const fixture = createFixture();
    await fixture.managed.admit(workerRequest);
    fixture.waitForRun
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "ok" });
    fixture.abortManagedRun
      .mockRejectedValueOnce(new Error("abort response lost"))
      .mockResolvedValue({ aborted: true });

    await expect(fixture.managed.cancel({ key: workerRequest.key })).rejects.toThrow(
      "cancellation outcome is uncertain",
    );
    expect((await fixture.managed.find({ key: workerRequest.key }))?.status).toBe(
      "cancellation_uncertain",
    );

    const recovered = await fixture.createManaged().cancel({ key: workerRequest.key });
    expect(recovered).toMatchObject({ status: "cancelled", lease: { status: "released" } });
    expect(fixture.abortManagedRun).toHaveBeenCalledTimes(2);
    const abortCalls = fixture.abortManagedRun.mock.calls;
    expect(abortCalls[0]?.[0]).toEqual(abortCalls[1]?.[0]);
  });

  it("reconciles an uncertain abort to terminal success without aborting a replacement", async () => {
    const fixture = createFixture();
    await fixture.managed.admit(workerRequest);
    fixture.abortManagedRun.mockRejectedValueOnce(new Error("abort response lost"));

    const reconciled = await fixture.managed.cancel({ key: workerRequest.key });
    expect(reconciled).toMatchObject({
      status: "succeeded",
      artifact: { commit: ARTIFACT_COMMIT },
      lease: { status: "released" },
    });
    expect(fixture.abortManagedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: reconciled.execution?.runId,
        sessionId: reconciled.execution?.sessionId,
        lifecycleRevision: reconciled.execution?.lifecycleRevision,
        requestFingerprint: reconciled.execution?.requestFingerprint,
      }),
    );
  });

  it("recovers a crash at immutable artifact publication without changing the artifact", async () => {
    const fixture = createFixture();
    await fixture.managed.admit(workerRequest);
    vi.mocked(fixture.store.compareAndApply).mockRejectedValueOnce(
      new Error("artifact publication response lost"),
    );

    await expect(fixture.managed.inspect({ key: workerRequest.key })).rejects.toThrow(
      "publication outcome is uncertain",
    );
    expect((await fixture.managed.find({ key: workerRequest.key }))?.status).toBe("running");

    const recovered = await fixture.createManaged().inspect({ key: workerRequest.key });
    expect(recovered.artifact?.commit).toBe(ARTIFACT_COMMIT);
    expect(fixture.captureGitArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("fails and cleans up a definitive worker artifact validation error", async () => {
    const fixture = createFixture();
    await fixture.managed.admit(workerRequest);
    fixture.captureGitArtifact.mockRejectedValueOnce(
      new PluginWorktreeValidationError("dirty_checkout", "checkout is dirty"),
    );

    const failed = await fixture.managed.inspect({ key: workerRequest.key });
    expect(failed).toMatchObject({
      status: "failed",
      error: "checkout is dirty",
      lease: { status: "released" },
    });
  });

  it("retries an uncertain exact worktree release after restart", async () => {
    const fixture = createFixture();
    fixture.release
      .mockRejectedValueOnce(new Error("release response lost"))
      .mockResolvedValue("released");

    await fixture.managed.admit(workerRequest);
    await expect(fixture.managed.inspect({ key: workerRequest.key })).rejects.toThrow(
      "release outcome is uncertain",
    );
    expect((await fixture.managed.find({ key: workerRequest.key }))?.lease?.status).toBe(
      "release_pending",
    );

    const recovered = await fixture.createManaged().inspect({ key: workerRequest.key });
    expect(recovered.lease?.status).toBe("released");
    expect(fixture.release).toHaveBeenCalledTimes(2);
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("reconciles a checkout already retired before cleanup publication", async () => {
    const fixture = createFixture();
    fixture.release.mockResolvedValueOnce("released").mockResolvedValueOnce("already_retired");
    vi.mocked(fixture.runtime.worktrees.removeIfLosslessExact).mockRejectedValueOnce(
      new Error("retirement response lost"),
    );

    await fixture.managed.admit(workerRequest);
    await expect(fixture.managed.inspect({ key: workerRequest.key })).rejects.toThrow(
      "release outcome is uncertain",
    );
    const recovered = await fixture.createManaged().inspect({ key: workerRequest.key });
    expect(recovered.lease?.status).toBe("released");
    expect(fixture.release).toHaveBeenCalledTimes(2);
  });

  it("does not delete a replacement when exact worktree release no longer matches", async () => {
    const fixture = createFixture();
    fixture.release.mockResolvedValueOnce("mismatch");

    const completed = await completeWorker(fixture);
    expect(completed.lease).toMatchObject({
      status: "retained",
      error: expect.stringContaining("replacement was not touched"),
    });
    expect(fixture.runtime.worktrees.removeIfLosslessExact).not.toHaveBeenCalled();
  });

  it("persists a released-but-retained checkout when lossless removal is refused", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.runtime.worktrees.removeIfLosslessExact).mockResolvedValueOnce("retained");

    const completed = await completeWorker(fixture);
    expect(completed.lease).toMatchObject({
      status: "retained",
      error: expect.stringContaining("lossless checkout removal was refused"),
    });
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("supports exact-incarnation verifier cancellation and cleanup", async () => {
    const fixture = createFixture();
    await completeWorker(fixture);
    const admitted = await fixture.managed.admitVerifier({
      key: workerRequest.key,
      agentId: "reviewer",
      message: "Review it",
    });

    const cancelled = await fixture.managed.cancelVerifier({ key: workerRequest.key });
    expect(cancelled.verifier).toMatchObject({
      status: "cancelled",
      lease: { status: "released" },
    });
    expect(fixture.abortManagedRun).toHaveBeenLastCalledWith({
      runId: admitted.verifier?.execution?.runId,
      sessionKey: admitted.verifier?.execution?.sessionKey,
      sessionId: admitted.verifier?.execution?.sessionId,
      lifecycleRevision: admitted.verifier?.execution?.lifecycleRevision,
      requestFingerprint: admitted.verifier?.execution?.requestFingerprint,
    });
    expect(fixture.run.mock.calls[1]?.[0]).not.toHaveProperty("cwd");
  });

  it("retires an interrupted accepted verifier whose durable session omitted lifecycle identity", async () => {
    const fixture = createFixture();
    await completeWorker(fixture);
    fixture.run.mockImplementationOnce(async (params) => {
      fixture.sessions.set(params.sessionKey, {
        sessionId: "accepted-verifier-without-revision",
        pluginOwnerId: "example-plugin",
        modelSelectionLocked: true,
        pluginManagedRun: {
          ...params.managedRun!,
          pluginId: "example-plugin",
          acceptedAt: 1_001,
        },
      });
      throw new Error("host crashed after durable verifier acceptance");
    });
    fixture.waitForRun.mockResolvedValueOnce({
      status: "error",
      error: "interrupted by Gateway restart",
    });

    await expect(
      fixture.managed.admitVerifier({
        key: workerRequest.key,
        agentId: "reviewer",
        message: "Verify it",
      }),
    ).rejects.toThrow("admission outcome is uncertain");
    const retired = await fixture.createManaged().inspectVerifier({ key: workerRequest.key });

    expect(retired.verifier).toMatchObject({
      status: "failed",
      lease: { status: "released" },
      error: expect.stringContaining("did not publish lifecycleRevision"),
    });
    expect(retired.verifier).not.toHaveProperty("execution");
    expect(fixture.run).toHaveBeenCalledTimes(2);
    expect(fixture.abortManagedRun).not.toHaveBeenCalled();
  });

  it("refuses verifier dispatch when the immutable artifact checkout moved", async () => {
    const fixture = createFixture();
    await completeWorker(fixture);
    vi.mocked(fixture.runtime.worktrees.assertPinnedCommit).mockRejectedValueOnce(
      new Error("verifier checkout moved"),
    );

    await expect(
      fixture.managed.admitVerifier({
        key: workerRequest.key,
        agentId: "reviewer",
        message: "Verify it",
      }),
    ).rejects.toThrow("verifier checkout moved");
    expect((await fixture.managed.find({ key: workerRequest.key }))?.verifier?.status).toBe(
      "failed",
    );
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("fails and cleans up a definitive verifier pin validation error", async () => {
    const fixture = createFixture();
    await completeWorker(fixture);
    await fixture.managed.admitVerifier({
      key: workerRequest.key,
      agentId: "reviewer",
      message: "Verify it",
    });
    vi.mocked(fixture.runtime.worktrees.assertPinnedCommit).mockRejectedValueOnce(
      new PluginWorktreeValidationError("pinned_commit_moved", "verifier checkout moved"),
    );

    const failed = await fixture.managed.inspectVerifier({ key: workerRequest.key });
    expect(failed.verifier).toMatchObject({
      status: "failed",
      error: "verifier checkout moved",
      lease: { status: "released" },
    });
  });

  it("recovers a crash at verifier evidence publication without a second verifier", async () => {
    const fixture = createFixture();
    await completeWorker(fixture);
    await fixture.managed.admitVerifier({
      key: workerRequest.key,
      agentId: "reviewer",
      message: "Verify it",
    });
    vi.mocked(fixture.store.compareAndApply).mockRejectedValueOnce(
      new Error("verifier evidence publication response lost"),
    );

    await expect(fixture.managed.inspectVerifier({ key: workerRequest.key })).rejects.toThrow(
      "publication outcome is uncertain",
    );
    const recovered = await fixture.createManaged().inspectVerifier({ key: workerRequest.key });
    expect(recovered.verifier).toMatchObject({
      status: "succeeded",
      lease: { status: "released" },
    });
    expect(fixture.run).toHaveBeenCalledTimes(2);
  });

  it("records verifier authority refusal as definitive and never dispatches it", async () => {
    const fixture = createFixture({ verifierAccess: "rw" });
    await completeWorker(fixture);

    await expect(
      fixture.managed.admitVerifier({
        key: workerRequest.key,
        agentId: "reviewer",
        message: "Verify it",
      }),
    ).rejects.toThrow("requires exact ro workspace authority");
    const record = await fixture.managed.find({ key: workerRequest.key });
    expect(record?.verifier).toMatchObject({ status: "failed", lease: { status: "released" } });
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
});
