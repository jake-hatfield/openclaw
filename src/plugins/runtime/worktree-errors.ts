export type PluginWorktreeValidationCode =
  | "checkout_commit_mismatch"
  | "dirty_checkout"
  | "invalid_commit"
  | "non_descendant_commit"
  | "pinned_commit_moved"
  | "identity_mismatch";

/** Definitive managed-run checkout refusal; safe to record as terminal and clean up. */
export class PluginWorktreeValidationError extends Error {
  constructor(
    readonly code: PluginWorktreeValidationCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginWorktreeValidationError";
  }
}
