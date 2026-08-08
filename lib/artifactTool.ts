import { PUBLIC_BASE_URL } from "./config";
import { publishArtifact } from "./artifacts";
import type { Project, Task } from "./types";
import { addMessage } from "./store";
import { publish } from "./events";
import { encodeArtifactNotice } from "./artifactNotice";

export interface PublishTaskArtifactInput {
  path: string;
  title?: string;
}

export interface PublishTaskArtifactResult {
  status: "published";
  artifactId: string;
  title: string;
  url: string;
  libraryUrl: string;
  text: string;
}

function appUrl(pathname: string): string {
  return `${PUBLIC_BASE_URL}${pathname}`;
}

export function publishTaskArtifact(
  task: Task,
  project: Project,
  input: PublishTaskArtifactInput,
): PublishTaskArtifactResult {
  if (typeof input.path !== "string" || !input.path.trim()) {
    throw new Error("Artifact path is required.");
  }
  const artifact = publishArtifact({
    task,
    project,
    sourcePath: input.path.trim(),
    title: input.title,
  });
  const url = appUrl(`/artifacts/${artifact.id}`);
  const libraryUrl = appUrl("/artifacts");
  const notice = addMessage(
    task.id,
    task.generation,
    "system",
    encodeArtifactNotice({
      id: artifact.id,
      title: artifact.title,
      filename: artifact.filename,
      url,
      libraryUrl,
    }),
  );
  publish(task.id, {
    type: "notice",
    content: notice.content,
    msgId: notice.id,
    generation: notice.generation,
    createdAt: notice.created_at,
  });
  return {
    status: "published",
    artifactId: artifact.id,
    title: artifact.title,
    url,
    libraryUrl,
    text:
      `Published "${artifact.title}" to Operator Artifacts. ` +
      `Give the user this exact link: ${url}. ` +
      `All published artifacts: ${libraryUrl}.`,
  };
}
