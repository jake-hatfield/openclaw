import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import * as config from "../../config/config.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import * as gatewayOwner from "../../infra/gateway-state-owner.js";
import { createPluginRuntime } from "./index.js";

const effects = vi.hoisted(() => ({
  create: vi.fn(),
  acquire: vi.fn(),
  findLiveByOwner: vi.fn(),
  listRegistryRecords: vi.fn(),
  release: vi.fn(),
  releaseByPath: vi.fn(),
  removeIfLossless: vi.fn(),
  removeIfLosslessByPath: vi.fn(),
}));

// mock-isolation: Observe domain effects without opening databases or running Git.
vi.mock("../../agents/worktrees/service.js", () => ({
  managedWorktrees: effects,
  ManagedWorktreeService: class {
    create = effects.create;
    acquire = effects.acquire;
    findLiveByOwner = effects.findLiveByOwner;
    listRegistryRecords = effects.listRegistryRecords;
    release = effects.release;
    releaseByPath = effects.releaseByPath;
    removeIfLossless = effects.removeIfLossless;
    removeIfLosslessByPath = effects.removeIfLosslessByPath;
  },
}));

const roots = useAutoCleanupTempDirTracker(afterEach);
const createParams = {
  repoRoot: "/repo",
  name: "plugin-owned",
  ownerKind: "workboard" as const,
  ownerId: "card-1",
};
const exactTarget = {
  id: "worktree-1",
  path: "/checkout",
  branch: "plugin-owned",
  repoRoot: "/repo",
  repoFingerprint: "repo-fingerprint",
  baseRef: "HEAD",
  baseCommit: "1".repeat(40),
  createdAt: 1,
  ownerKind: "workboard" as const,
  ownerId: "card-1",
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("plugin-worktree-owner-"));
  vi.spyOn(config, "getRuntimeConfig").mockReturnValue({});
  vi.spyOn(gatewayOwner, "captureGatewayStateOwner").mockReturnValue(undefined);
  vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
    pid: process.pid + 1,
    ownerId: "foreign-owner",
    createdAt: "2026-01-01T00:00:00Z",
    port: 18789,
  });
  effects.create.mockResolvedValue(exactTarget);
  effects.findLiveByOwner.mockResolvedValue(exactTarget);
  effects.listRegistryRecords.mockResolvedValue([exactTarget]);
  effects.removeIfLossless.mockResolvedValue(true);
  effects.removeIfLosslessByPath.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("plugin worktree state ownership", () => {
  it.each(["create", "release", "removeIfLossless"] as const)(
    "refuses %s before domain effects when another process owns the state",
    async (operation) => {
      const worktrees = createPluginRuntime().worktrees;
      const pending =
        operation === "create"
          ? worktrees.create(createParams)
          : operation === "release"
            ? worktrees.release(exactTarget)
            : worktrees.removeIfLossless(exactTarget);
      await expect(pending).rejects.toMatchObject({
        code: "OWNER_UNAVAILABLE",
        message: expect.stringContaining("No local mutation was attempted"),
      });
      for (const effect of Object.values(effects)) {
        expect(effect).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves the plugin guard and rejects authority loss after awaited creation", async () => {
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("owner retired");
      }
    };
    vi.mocked(gatewayOwner.captureGatewayStateOwner).mockReturnValue({
      ownerId: "hosted-owner",
      role: "gateway",
      assertCurrent,
      signal: new AbortController().signal,
    });
    effects.create.mockImplementationOnce(async (params: { commitGuard: () => void }) => {
      params.commitGuard();
      current = false;
      return exactTarget;
    });
    const pluginGuard = vi.fn();
    await expect(
      createPluginRuntime().worktrees.create({ ...createParams, commitGuard: pluginGuard }),
    ).rejects.toThrow("owner retired");
    expect(pluginGuard).toHaveBeenCalled();
    expect(effects.create).toHaveBeenCalledOnce();
    expect(effects.acquire).not.toHaveBeenCalled();
  });

  it("keeps legacy path cleanup methods compatible", async () => {
    vi.mocked(gatewayOwner.captureGatewayStateOwner).mockReturnValue({
      ownerId: "hosted-owner",
      role: "gateway",
      assertCurrent: () => {},
      signal: new AbortController().signal,
    });
    const worktrees = createPluginRuntime().worktrees;

    await worktrees.release({ path: exactTarget.path });
    await expect(
      worktrees.removeIfLossless({
        path: exactTarget.path,
        ownerKind: exactTarget.ownerKind,
        ownerId: exactTarget.ownerId,
      }),
    ).resolves.toBe(true);
    expect(effects.releaseByPath).toHaveBeenCalledWith(
      exactTarget.path,
      expect.objectContaining({ commitGuard: expect.any(Function) }),
    );
    expect(effects.removeIfLosslessByPath).toHaveBeenCalledOnce();
  });

  it("keeps an artifact checkout reachable beyond snapshot retention and aggressive Git GC", async () => {
    vi.mocked(gatewayOwner.captureGatewayStateOwner).mockReturnValue({
      ownerId: "hosted-owner",
      role: "gateway",
      assertCurrent: () => {},
      signal: new AbortController().signal,
    });
    const repoRoot = roots.make("managed-artifact-repo-");
    await requireGit(repoRoot, ["init"]);
    await requireGit(repoRoot, ["config", "user.email", "managed-runs@example.test"]);
    await requireGit(repoRoot, ["config", "user.name", "Managed Runs Test"]);
    await writeFile(path.join(repoRoot, "artifact.txt"), "base\n");
    await requireGit(repoRoot, ["add", "artifact.txt"]);
    await requireGit(repoRoot, ["commit", "-m", "base"]);
    const baseCommit = await requireGit(repoRoot, ["rev-parse", "HEAD^{commit}"]);
    await writeFile(path.join(repoRoot, "artifact.txt"), "artifact\n");
    await requireGit(repoRoot, ["commit", "-am", "artifact"]);
    const artifactCommit = await requireGit(repoRoot, ["rev-parse", "HEAD^{commit}"]);
    const target = { ...exactTarget, path: repoRoot, repoRoot, baseCommit };
    effects.findLiveByOwner.mockResolvedValue(target);
    effects.listRegistryRecords.mockResolvedValue([target]);

    const worktrees = createPluginRuntime().worktrees;
    const artifact = await worktrees.captureGitArtifact({ ...target, baseCommit });
    expect(artifact).toMatchObject({
      commit: artifactCommit,
      retentionRef: expect.stringMatching(/^refs\/openclaw\/managed-runs\/[a-f0-9]{64}$/u),
    });

    // Emulate cleanup after the ordinary 30-day snapshot window: remove every normal
    // branch/reflog reachability source, expire reflogs, and prune unreachable objects.
    await requireGit(repoRoot, ["reset", "--hard", baseCommit]);
    await requireGit(repoRoot, ["reflog", "expire", "--expire=now", "--all"]);
    await requireGit(repoRoot, ["gc", "--prune=now"]);
    const verifierCheckout = roots.make("managed-artifact-verifier-");
    await requireGit(repoRoot, ["worktree", "add", "--detach", verifierCheckout, artifactCommit]);
    await expect(requireGit(verifierCheckout, ["rev-parse", "HEAD^{commit}"])).resolves.toBe(
      artifactCommit,
    );

    await expect(
      worktrees.releaseGitArtifact({
        repoRoot,
        retentionRef: artifact.retentionRef,
        commit: artifactCommit,
      }),
    ).resolves.toBe("released");
    await expect(
      worktrees.releaseGitArtifact({
        repoRoot,
        retentionRef: artifact.retentionRef,
        commit: artifactCommit,
      }),
    ).resolves.toBe("already_released");
  });

  it("distinguishes an already-retired exact checkout from a replacement", async () => {
    vi.mocked(gatewayOwner.captureGatewayStateOwner).mockReturnValue({
      ownerId: "hosted-owner",
      role: "gateway",
      assertCurrent: () => {},
      signal: new AbortController().signal,
    });
    const worktrees = createPluginRuntime().worktrees;
    effects.findLiveByOwner.mockResolvedValueOnce(undefined);
    effects.listRegistryRecords.mockResolvedValueOnce([{ ...exactTarget, removedAt: 2 }]);
    await expect(worktrees.releaseExact(exactTarget)).resolves.toBe("already_retired");
    expect(effects.release).not.toHaveBeenCalled();

    effects.findLiveByOwner.mockResolvedValueOnce({ ...exactTarget, id: "replacement" });
    await expect(worktrees.releaseExact(exactTarget)).resolves.toBe("mismatch");
    expect(effects.release).not.toHaveBeenCalled();
  });
});
