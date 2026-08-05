import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Boot trigger for the durable workstream outbox. The worker claims persisted
// pending, failed, and expired-delivery rows; it never clears the outbox.
export async function POST() {
  const { startWorkstreamWorker } = await import("@/lib/workstreams/worker");
  const summary = await startWorkstreamWorker();
  return NextResponse.json({ ok: true, ...summary });
}
