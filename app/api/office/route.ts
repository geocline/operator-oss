import { NextResponse } from "next/server";
import { listOfficeProjects, listOfficeTasks } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    projects: listOfficeProjects(),
    tasks: listOfficeTasks(),
  });
}
