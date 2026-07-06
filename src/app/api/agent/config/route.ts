import { NextResponse } from "next/server";
import { describeAgentConfig, loadAgentConfig } from "@/lib/agent/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(describeAgentConfig(loadAgentConfig()));
}
