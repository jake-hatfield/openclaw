import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSubagentAdmissionError } from "../plugin-sdk/error-runtime.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";

const gateway = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getContext: vi.fn(),
  loadSession: vi.fn(),
}));

vi.mock("./server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcess: gateway.dispatch,
  getInProcessGatewayRequestContext: gateway.getContext,
  prepareInProcessAgentExecution: vi.fn(),
  withInProcessGatewayRead: vi.fn(),
}));
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: gateway.loadSession,
}));

const PLUGIN_ID = "managed-host-test";
const SESSION_KEY = "agent:worker:subagent:managed-task";
const RUN_ID = "managed-worker-run";
const FINGERPRINT = "f".repeat(64);
const config = { agents: { entries: { worker: {} } } };
const context = { getRuntimeConfig: () => config };

function runtime() {
  return createGatewaySubagentRuntime(() => context as never, {}, new AbortController().signal);
}

function runManaged(target: PluginRuntime["subagent"] = runtime()) {
  return withPluginRuntimePluginScope({ pluginId: PLUGIN_ID }, () =>
    target.run({
      sessionKey: SESSION_KEY,
      message: "Perform managed work",
      deliver: false,
      idempotencyKey: RUN_ID,
      managedRun: { version: 1, runId: RUN_ID, requestFingerprint: FINGERPRINT },
    }),
  );
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    entry: {
      sessionId: "session-1",
      lifecycleRevision: "lifecycle-1",
      pluginOwnerId: PLUGIN_ID,
      modelSelectionLocked: true,
      pluginManagedRun: {
        version: 1,
        pluginId: PLUGIN_ID,
        runId: RUN_ID,
        requestFingerprint: FINGERPRINT,
        acceptedAt: 123,
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gateway.getContext.mockReturnValue(context);
  gateway.loadSession.mockResolvedValue({ entry: undefined });
});

describe("managed plugin run Gateway trust boundary", () => {
  it("binds plugin ownership and exact deterministic identity before accepting", async () => {
    gateway.dispatch.mockImplementationOnce(async (_method, params, options) => {
      expect(params).toMatchObject({
        sessionKey: SESSION_KEY,
        idempotencyKey: RUN_ID,
        deliver: false,
      });
      expect(options).toMatchObject({
        pluginRuntimeOwnerId: PLUGIN_ID,
        pluginManagedRun: { version: 1, runId: RUN_ID, requestFingerprint: FINGERPRINT },
      });
      options.onAccepted();
      return { runId: RUN_ID, sessionKey: SESSION_KEY };
    });

    await expect(runManaged()).resolves.toEqual({ runId: RUN_ID, sessionKey: SESSION_KEY });
  });

  it("rejects a mismatched accepted run or session identity as uncertain", async () => {
    gateway.dispatch.mockResolvedValueOnce({ runId: "replacement-run", sessionKey: SESSION_KEY });
    await expect(runManaged()).rejects.toMatchObject({ outcome: "uncertain" });

    gateway.dispatch.mockResolvedValueOnce({
      runId: RUN_ID,
      sessionKey: "agent:worker:replacement",
    });
    await expect(runManaged()).rejects.toMatchObject({ outcome: "uncertain" });
  });

  it("recovers a lost admission response from the durable receipt after restart", async () => {
    gateway.dispatch.mockRejectedValueOnce(new Error("response transport lost"));
    gateway.loadSession.mockResolvedValueOnce(receipt());

    const firstHost = runtime();
    const error = await runManaged(firstHost).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PluginSubagentAdmissionError);
    expect(error).toMatchObject({ outcome: "uncertain" });
    expect(gateway.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ key: SESSION_KEY, agentId: "worker" }),
    );

    gateway.dispatch.mockRejectedValueOnce(new Error("restarted host still has no response"));
    gateway.loadSession.mockResolvedValueOnce(receipt());
    await expect(runManaged(runtime())).rejects.toMatchObject({ outcome: "uncertain" });
    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
  });

  it("orders durable acceptance before the externally visible accepted callback", async () => {
    const events: string[] = [];
    gateway.dispatch.mockImplementationOnce(async (_method, _params, options) => {
      events.push("receipt-written");
      options.onAccepted();
      events.push("accepted-callback");
      throw new Error("response lost after acceptance");
    });
    gateway.loadSession.mockImplementationOnce(async () => {
      events.push("receipt-read");
      return receipt();
    });

    await expect(runManaged()).rejects.toMatchObject({ outcome: "uncertain" });
    expect(events).toEqual(["receipt-written", "accepted-callback", "receipt-read"]);
  });

  it("distinguishes definitive refusal and receipt-write failure from uncertain admission", async () => {
    gateway.dispatch.mockRejectedValueOnce(new Error("policy refused before acceptance"));
    gateway.loadSession.mockResolvedValueOnce({ entry: undefined });
    await expect(runManaged()).rejects.toMatchObject({ outcome: "refused" });

    gateway.dispatch.mockRejectedValueOnce(new Error("acceptance receipt write failed"));
    gateway.loadSession.mockResolvedValueOnce({ entry: undefined });
    await expect(runManaged()).rejects.toMatchObject({ outcome: "refused" });

    gateway.dispatch.mockImplementationOnce(async (_method, _params, options) => {
      options.onAccepted();
      throw new Error("response lost after acceptance");
    });
    gateway.loadSession.mockResolvedValueOnce({ entry: undefined });
    await expect(runManaged()).rejects.toMatchObject({ outcome: "uncertain" });
  });

  it("treats receipt lookup failure as uncertain and rejects foreign plugin ownership", async () => {
    gateway.dispatch.mockRejectedValue(new Error("response unavailable"));
    gateway.loadSession.mockRejectedValueOnce(new Error("session store unavailable"));
    await expect(runManaged()).rejects.toMatchObject({ outcome: "uncertain" });

    gateway.loadSession.mockResolvedValueOnce(receipt({ pluginOwnerId: "other-plugin" }));
    await expect(runManaged()).rejects.toMatchObject({ outcome: "refused" });
  });

  it("fences cancellation to the exact session and run identity across dispatch", async () => {
    gateway.loadSession.mockResolvedValue(receipt());
    gateway.dispatch.mockImplementationOnce(async (method, params, options) => {
      expect(method).toBe("chat.abort");
      expect(params).toEqual({ runId: RUN_ID, sessionKey: SESSION_KEY });
      expect(options).toMatchObject({ pluginRuntimeOwnerId: PLUGIN_ID });
      return { aborted: true };
    });

    const result = withPluginRuntimePluginScope({ pluginId: PLUGIN_ID }, () =>
      runtime().abortManagedRun({
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        sessionId: "session-1",
        lifecycleRevision: "lifecycle-1",
        requestFingerprint: FINGERPRINT,
      }),
    );
    await expect(result).resolves.toEqual({ aborted: true });
    expect(gateway.loadSession).toHaveBeenCalledTimes(2);
  });

  it("refuses cancellation when a replacement session appears after abort dispatch", async () => {
    gateway.loadSession
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(receipt({ sessionId: "replacement-session" }));
    gateway.dispatch.mockResolvedValueOnce({ aborted: true });

    await expect(
      withPluginRuntimePluginScope({ pluginId: PLUGIN_ID }, () =>
        runtime().abortManagedRun({
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          sessionId: "session-1",
          lifecycleRevision: "lifecycle-1",
          requestFingerprint: FINGERPRINT,
        }),
      ),
    ).rejects.toThrow("session incarnation, owner, or fingerprint no longer matches");
  });
});
