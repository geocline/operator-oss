import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  addAskAnswerMessage,
  createProject,
  createTask,
  listMessages,
} from "@/lib/store";
import { submitAnswer, waitForAnswer } from "@/lib/asks";
import { POST as answerRoute } from "@/app/api/tasks/[id]/answer/route";
import type { AskQuestion } from "@/lib/types";

describe("durable transcript replies", () => {
  it("stores one idempotent user entry per answered ask", () => {
    const project = createProject({ name: "Transcript" });
    const task = createTask({ project_id: project.id, title: "Question" });

    const first = addAskAnswerMessage(task.id, task.generation, "ask-1", "- Budget: $5M");
    const second = addAskAnswerMessage(task.id, task.generation, "ask-1", "- Budget: $5M");

    expect(second.id).toBe(first.id);
    expect(
      listMessages(task.id).filter((message) => message.source === "ask_answer"),
    ).toHaveLength(1);
    expect(first).toMatchObject({
      role: "user",
      source: "ask_answer",
      source_id: "ask-1",
    });
  });

  it("persists an accepted live question-card answer before returning success", async () => {
    const project = createProject({ name: "Live answer" });
    const task = createTask({ project_id: project.id, title: "Live question" });
    const questions: AskQuestion[] = [{
      question: "What is the budget?",
      header: "Budget",
      options: [{ label: "$5M" }, { label: "$10M" }],
    }];
    const waiting = waitForAnswer(task.id, "ask-live", questions);

    const response = await answerRoute(
      new NextRequest(`http://operator.test/api/tasks/${task.id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          askId: "ask-live",
          questions,
          answers: [["$5M"]],
        }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolved: true });
    await expect(waiting).resolves.toEqual([["$5M"]]);
    expect(listMessages(task.id).at(-1)).toMatchObject({
      role: "user",
      source: "ask_answer",
      source_id: "ask-live",
      content: "Answering your question:\n- What is the budget? (Budget): $5M",
    });

    const retry = await answerRoute(
      new NextRequest(`http://operator.test/api/tasks/${task.id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ askId: "ask-live", answers: [["$5M"]] }),
      }),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(await retry.json()).toMatchObject({ resolved: true, replayed: true });
    expect(
      listMessages(task.id).filter((message) => message.source_id === "ask-live"),
    ).toHaveLength(1);
  });

  it("keeps a live ask pending when transcript persistence fails", async () => {
    const project = createProject({ name: "Retry answer" });
    const task = createTask({ project_id: project.id, title: "Retry question" });
    const questions: AskQuestion[] = [{
      question: "Choose one",
      header: "Choice",
      options: [{ label: "A" }],
    }];
    const waiting = waitForAnswer(task.id, "ask-retry", questions);
    expect(() =>
      submitAnswer(task.id, "ask-retry", [["A"]], () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(submitAnswer(task.id, "ask-retry", [["A"]])).toBe(true);
    await expect(waiting).resolves.toEqual([["A"]]);
  });

  it("preserves database timestamps and provenance in the client stream", () => {
    const types = fs.readFileSync(
      path.join(process.cwd(), "app/orchestrator/types.ts"),
      "utf8",
    );
    const stream = fs.readFileSync(
      path.join(process.cwd(), "app/orchestrator/useTaskStream.ts"),
      "utf8",
    );
    const transcript = fs.readFileSync(
      path.join(process.cwd(), "app/orchestrator/Transcript.tsx"),
      "utf8",
    );
    expect(types).toContain("createdAt");
    expect(types).toContain("source");
    expect(stream).toContain("created_at");
    expect(transcript).toContain("<time");
    expect(transcript).toContain("ask_answer");
    expect(stream).not.toContain("setAnswerOnMsg(taskId, askId, answers); // optimistic");
    expect(transcript).toContain("await onAnswer");
    expect(transcript).toContain("setSubmitted(false)");
  });
});
