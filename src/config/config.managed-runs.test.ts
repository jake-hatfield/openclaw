import { describe, expect, it } from "vitest";
import { normalizePluginsConfigWithResolver } from "../plugins/config-policy.js";
import { validateConfigObject } from "./validation.js";

const managedRuns = {
  enabled: true,
  agentAllowlist: [" worker "],
  verifierAgentAllowlist: [" reviewer "],
  projects: [
    {
      projectId: " openclaw ",
      repoRoot: " /srv/openclaw ",
      baseRefs: [" refs/heads/main "],
    },
  ],
};

describe("managed run plugin policy", () => {
  it("accepts and normalizes exact project registrations", () => {
    const raw = { plugins: { entries: { release: { managedRuns } } } };
    const parsed = validateConfigObject(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(
      normalizePluginsConfigWithResolver(parsed.config.plugins).entries.release?.managedRuns,
    ).toEqual({
      enabled: true,
      agentAllowlist: ["worker"],
      verifierAgentAllowlist: ["reviewer"],
      projects: [
        {
          projectId: "openclaw",
          repoRoot: "/srv/openclaw",
          baseRefs: ["refs/heads/main"],
        },
      ],
    });
  });

  it("rejects empty exact base-ref registrations and unknown policy keys", () => {
    expect(
      validateConfigObject({
        plugins: {
          entries: {
            release: {
              managedRuns: {
                ...managedRuns,
                projects: [{ projectId: "openclaw", repoRoot: "/srv/openclaw", baseRefs: [] }],
              },
            },
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateConfigObject({
        plugins: {
          entries: { release: { managedRuns: { ...managedRuns, arbitraryCommand: true } } },
        },
      }).ok,
    ).toBe(false);
  });
});
