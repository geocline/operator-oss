import { describe, expect, it } from "vitest";
import {
  launchConfigurationSummary,
  needsLaunchConfiguration,
  reasoningChoicesFor,
  suggestLaunchConfiguration,
} from "@/app/orchestrator/launchConfig";
import type {
  AgentsBundle,
  TaskRow,
} from "@/app/orchestrator/types";

const capabilities = {
  models: [
    {
      value: "alpha-frontier",
      label: "Alpha Frontier",
      sub: "recommended",
      contextWindow: 200_000,
      reasoningValues: ["think"],
    },
    {
      value: "alpha-fast",
      label: "Alpha Fast",
      sub: "quick",
      contextWindow: 200_000,
      reasoningValues: ["off", "think"],
    },
  ],
  reasoningOptions: [
    { value: "off", label: "Low", sub: "low effort" },
    { value: "think", label: "Medium", sub: "balanced" },
    { value: "think_hard", label: "High", sub: "deep" },
  ],
  permissionModes: [],
  supportsAsks: true,
  supportsMcpTools: true,
  reportsCostUsd: false,
  costIsEstimated: false,
  supportsResume: true,
};

const agents: AgentsBundle = {
  default: "alpha",
  agents: [
    {
      id: "alpha",
      label: "Alpha harness",
      authenticated: true,
      capabilities,
    },
    {
      id: "beta",
      label: "Beta harness",
      authenticated: true,
      capabilities: {
        ...capabilities,
        models: [
          {
            value: "beta-one",
            label: "Beta One",
            sub: "recommended",
            contextWindow: 100_000,
          },
        ],
        reasoningOptions: [
          { value: "think_hard", label: "High", sub: "deep" },
        ],
      },
    },
  ],
};

const task = {
  agent: "alpha",
  model: null,
  reasoning: null,
} as TaskRow;

describe("suggested task launch configuration choices", () => {
  it("uses recommended supported values instead of an incompatible app default", () => {
    expect(
      suggestLaunchConfiguration(task, agents, {
        "default_reasoning:alpha": "think_hard",
      }),
    ).toEqual({
      agent: "alpha",
      model: "alpha-frontier",
      reasoning: "think",
    });
  });

  it("refreshes model and thinking suggestions when the harness changes", () => {
    expect(
      suggestLaunchConfiguration(task, agents, {}, "beta"),
    ).toEqual({
      agent: "beta",
      model: "beta-one",
      reasoning: "think_hard",
    });
  });

  it("returns only the thinking strengths supported by the selected model", () => {
    expect(
      reasoningChoicesFor(agents, "alpha", "alpha-fast").map(
        (option) => option.value,
      ),
    ).toEqual(["off", "think"]);
  });

  it("treats a confirmed but model-incompatible thinking strength as stale", () => {
    const stale = {
      ...task,
      model: "alpha-frontier",
      reasoning: "think_hard",
      launch_config_required: 1,
      launch_config_confirmed_at: 123,
      started: 0,
    };

    expect(launchConfigurationSummary(stale, agents)).toBeNull();
    expect(needsLaunchConfiguration(stale, agents)).toBe(true);
  });
});
