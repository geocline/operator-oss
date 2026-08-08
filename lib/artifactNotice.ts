export const ARTIFACT_NOTICE_PREFIX = "__ORCH_ARTIFACT__:";

export interface ArtifactNotice {
  id: string;
  title: string;
  filename: string;
  url: string;
  libraryUrl: string;
}

export function encodeArtifactNotice(notice: ArtifactNotice): string {
  return `${ARTIFACT_NOTICE_PREFIX}${JSON.stringify(notice)}`;
}

export function decodeArtifactNotice(content: string): ArtifactNotice | null {
  if (!content.startsWith(ARTIFACT_NOTICE_PREFIX)) return null;
  try {
    const value = JSON.parse(
      content.slice(ARTIFACT_NOTICE_PREFIX.length),
    ) as Partial<ArtifactNotice>;
    if (
      typeof value.id !== "string" ||
      typeof value.title !== "string" ||
      typeof value.filename !== "string" ||
      typeof value.url !== "string" ||
      typeof value.libraryUrl !== "string"
    ) {
      return null;
    }
    return value as ArtifactNotice;
  } catch {
    return null;
  }
}

