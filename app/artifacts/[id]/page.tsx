import Link from "next/link";
import { notFound } from "next/navigation";
import { getArtifact } from "@/lib/artifacts";
import { getProject, getTask } from "@/lib/store";
import { CopyButton } from "../../CopyButton";

export const dynamic = "force-dynamic";

function canFrame(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type === "application/pdf" ||
    type === "image/svg+xml"
  );
}

export default async function ArtifactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const artifact = getArtifact(id);
  if (!artifact) notFound();
  const project = getProject(artifact.project_id);
  const task = getTask(artifact.task_id);
  if (!project || !task) notFound();

  const contentUrl = `/api/artifacts/${artifact.id}/content`;
  const downloadUrl = `/api/artifacts/${artifact.id}/download`;
  const isImage = artifact.content_type.startsWith("image/") &&
    artifact.content_type !== "image/svg+xml";

  return (
    <main className="artifact-shell detail">
      <header className="artifact-topbar">
        <Link href="/artifacts" className="artifact-brand">Artifacts</Link>
        <span className="artifact-divider">/</span>
        <strong>{artifact.title}</strong>
        <span className="artifact-spacer" />
        <Link
          href={`/?project=${artifact.project_id}&task=${artifact.task_id}`}
          className="artifact-back"
        >
          Open source task
        </Link>
      </header>

      <section className="artifact-detail-head">
        <div>
          <p className="artifact-eyebrow">{artifact.filename}</p>
          <h1>{artifact.title}</h1>
          <div className="artifact-detail-meta">
            <Link href={`/?project=${artifact.project_id}`}>{project.name}</Link>
            <span>·</span>
            <Link href={`/?project=${artifact.project_id}&task=${artifact.task_id}`}>{task.title}</Link>
            <span>·</span>
            <time dateTime={new Date(artifact.created_at).toISOString()}>
              {new Date(artifact.created_at).toLocaleString()}
            </time>
          </div>
        </div>
        <div className="artifact-detail-actions">
          <CopyButton text={`/artifacts/${artifact.id}`} label="Copy link" />
          <a href={downloadUrl} className="artifact-primary">Download</a>
        </div>
      </section>

      <section className="artifact-preview">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={contentUrl} alt={artifact.title} />
        ) : canFrame(artifact.content_type) ? (
          <iframe
            src={contentUrl}
            title={artifact.title}
            sandbox=""
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="artifact-state">
            <p>This file type downloads instead of previewing in the browser.</p>
            <a href={downloadUrl} className="artifact-primary">Download {artifact.filename}</a>
          </div>
        )}
      </section>
    </main>
  );
}

