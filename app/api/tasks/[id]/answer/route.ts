import { addAskAnswerMessage, getTask } from "@/lib/store";
import { submitAnswer } from "@/lib/asks";
import { publish } from "@/lib/events";
import type { AskAnswers, AskQuestion } from "@/lib/types";

export const dynamic = "force-dynamic";

// Deliver the user's answer to a Claude turn parked on an AskUserQuestion.
// `resolved: true`  → the live turn was waiting and will continue in its stream.
// `resolved: false` → nothing was waiting (e.g. the turn was torn down by a page
//   reload); the client resumes the session with the answer as a normal reply.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTask(id)) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const { askId, answers } = (await req.json()) as { askId?: string; answers?: AskAnswers };
  if (!askId || !Array.isArray(answers)) {
    return new Response(JSON.stringify({ error: "askId and answers are required" }), { status: 400 });
  }

  const task = getTask(id)!;
  const resolved = submitAnswer(id, askId, answers, (questions: AskQuestion[]) => {
    const lines = questions.map((question, index) => {
      const picked = (answers[index] ?? []).filter((value) => value?.trim());
      return `- ${question.header || question.question}: ${picked.length ? picked.join(", ") : "(no selection)"}`;
    });
    const content =
      `Answering your question${questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
    const message = addAskAnswerMessage(
      id,
      task.generation,
      askId,
      content,
    );
    publish(id, {
      type: "user",
      content: message.content,
      msgId: message.id,
      generation: message.generation,
      createdAt: message.created_at,
      source: message.source,
      sourceId: message.source_id,
    });
  });
  return Response.json({ resolved });
}
