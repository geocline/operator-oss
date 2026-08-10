import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { MessageView } from "@/app/orchestrator/Transcript";
import { ARTIFACT_NOTICE_PREFIX } from "@/lib/artifactNotice";
import type { Msg } from "@/app/orchestrator/types";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("does not timestamp the published-artifact system notice", () => {
  const notice = {
    id: "artifact-1",
    title: "Harness report",
    filename: "report.html",
    url: "/api/artifacts/artifact-1/content",
    libraryUrl: "/artifacts/artifact-1",
  };
  const message: Msg = {
    id: "system-artifact",
    role: "system",
    content: `${ARTIFACT_NOTICE_PREFIX}${JSON.stringify(notice)}`,
    generation: 1,
    createdAt: Date.parse("2026-08-08T15:30:00Z"),
  };
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(MessageView, {
        m: message,
        initial: false,
        hideWho: false,
        agent: "codex",
        agentLabel: "Codex",
      }),
    );
  });
  const root = renderer!.root as ReactTestInstance;
  expect(root.findAllByType("time")).toHaveLength(0);
});
