import { NextResponse } from "next/server";
import { OFFICE_SKIN_DIR } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Tells the client whether the LimeZu tile skin is available, so OfficeView
 * knows whether to mount RoomSkin canvases at all. Auth: Next.js Proxy. */
export async function GET() {
  return NextResponse.json({ enabled: OFFICE_SKIN_DIR !== "" });
}
