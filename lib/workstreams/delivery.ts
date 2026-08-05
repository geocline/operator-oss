import { nanoid } from "nanoid";
import {
  postWorkstreamUpdate,
  sendWorkstreamCommand,
} from "./client";
import type { WorkstreamLink } from "./types";

export const MANUAL_WORKSTREAM_UPDATE = "Work is in progress.";

export async function postManualWorkstreamUpdate(
  link: WorkstreamLink,
): Promise<boolean> {
  const permission = await sendWorkstreamCommand(
    link.external_workstream_id,
    "post-now",
  );
  if (!permission) return false;
  const oneShotToken =
    typeof permission.one_shot_token === "string"
      ? permission.one_shot_token
      : undefined;
  return Boolean(
    await postWorkstreamUpdate({
      externalWorkstreamId: link.external_workstream_id,
      idempotencyKey: `manual:${link.id}:${Date.now()}:${nanoid(8)}`,
      body: MANUAL_WORKSTREAM_UPDATE,
      oneShotToken,
    }),
  );
}
