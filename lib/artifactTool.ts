import { PUBLIC_BASE_URL } from "./config";
import { publishArtifact } from "./artifacts";
import type { Project, Task } from "./types";

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

