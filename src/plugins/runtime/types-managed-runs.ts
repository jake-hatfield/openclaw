/** Version-pinned plugin-owned background runs. */
export type ManagedRunStatus =
  | "prepared"
  | "worktree_ready"
  | "admitting"
  | "admission_uncertain"
  | "running"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancellation_uncertain"
  | "cancelled";

export type ManagedRunWorktreeIdentity = {
  id: string;
  path: string;
  branch: string;
  repoRoot: string;
  repoFingerprint: string;
  baseRef: string;
  baseCommit: string;
  createdAt: number;
};

export type ManagedRunExecutionPlan = {
  agentId: string;
  sessionKey: string;
  /** Deterministic host run identity; also used as the Gateway idempotency key. */
  runId: string;
  requestFingerprint: string;
  worktree: ManagedRunWorktreeIdentity;
};

export type ManagedRunExecutionIdentity = ManagedRunExecutionPlan & {
  sessionId: string;
  lifecycleRevision: string;
};

export type ManagedRunGitArtifact = {
  kind: "git_commit";
  commit: string;
  baseCommit: string;
  worktreeId: string;
  /** Dedicated Git ref that keeps the commit reachable after checkout snapshot GC. */
  retentionRef: string;
};

export type ManagedRunArtifactRetention = {
  status: "retained" | "release_pending" | "released";
  updatedAt: number;
  error?: string;
};

export type ManagedRunWorktreeLease = {
  status: "leased" | "release_pending" | "released" | "retained";
  updatedAt: number;
  error?: string;
};

export type ManagedRunVerifierRecord = {
  agentId: string;
  requestFingerprint: string;
  status: ManagedRunStatus;
  worktree?: ManagedRunWorktreeIdentity;
  lease?: ManagedRunWorktreeLease;
  admission?: ManagedRunExecutionPlan;
  execution?: ManagedRunExecutionIdentity;
  /** Exact immutable worker artifact checked out for verification. */
  artifact: ManagedRunGitArtifact;
  /** Host-captured terminal result the verifier was admitted to inspect. */
  workerResultHash: string;
  /** Immutable hash of the verifier transcript evidence. */
  evidenceHash?: string;
  error?: string;
};

export type ManagedRunRecord = {
  /** Schema version for this narrow runtime contract. */
  version: 1;
  pluginId: string;
  key: string;
  taskName: string;
  requestFingerprint: string;
  projectId: string;
  repoRoot: string;
  baseRef: string;
  /** Exact commit resolved before admission and included in the request fingerprint. */
  baseCommit: string;
  agentId: string;
  status: ManagedRunStatus;
  createdAt: number;
  updatedAt: number;
  worktree?: ManagedRunWorktreeIdentity;
  lease?: ManagedRunWorktreeLease;
  /** Published before dispatch so a lost response can never cause another worker. */
  admission?: ManagedRunExecutionPlan;
  execution?: ManagedRunExecutionIdentity;
  /** Host-inspected immutable Git artifact, never a worker-authored verification claim. */
  artifact?: ManagedRunGitArtifact;
  /** Reachability lease retained until the dependent verifier lifecycle is terminal. */
  artifactRetention?: ManagedRunArtifactRetention;
  /** Host-captured terminal result, published before artifact finalization and never replaced. */
  immutableResultHash?: string;
  error?: string;
  verifier?: ManagedRunVerifierRecord;
};

export type ManagedRunAdmitParams = {
  /** Plugin-scoped idempotency key. A changed request under the same key is rejected. */
  key: string;
  projectId: string;
  agentId: string;
  /** Must exactly match an operator-registered project base ref. */
  baseRef: string;
  message: string;
};

export type ManagedRunFindParams = { key: string };
export type ManagedRunInspectParams = { key: string; timeoutMs?: number };
export type ManagedRunCancelParams = { key: string };
export type ManagedRunAdmitVerifierParams = {
  key: string;
  agentId: string;
  message: string;
};
export type ManagedRunInspectVerifierParams = { key: string; timeoutMs?: number };
export type ManagedRunCancelVerifierParams = { key: string };

export type PluginRuntimeManagedRuns = {
  admit: (params: ManagedRunAdmitParams) => Promise<ManagedRunRecord>;
  find: (params: ManagedRunFindParams) => Promise<ManagedRunRecord | undefined>;
  inspect: (params: ManagedRunInspectParams) => Promise<ManagedRunRecord>;
  cancel: (params: ManagedRunCancelParams) => Promise<ManagedRunRecord>;
  admitVerifier: (params: ManagedRunAdmitVerifierParams) => Promise<ManagedRunRecord>;
  inspectVerifier: (params: ManagedRunInspectVerifierParams) => Promise<ManagedRunRecord>;
  cancelVerifier: (params: ManagedRunCancelVerifierParams) => Promise<ManagedRunRecord>;
};
