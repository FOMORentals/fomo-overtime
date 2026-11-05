import { NextResponse } from "next/server";
import { handleInteraction } from "@/lib/handlers";
import { report } from "@/lib/report";
import { verifySlackSignature } from "@/lib/slack";

export const maxDuration = 60;

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySlackSignature(raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature")))
    return new NextResponse("bad signature", { status: 401 });
  const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}");
  try {
    const body = await handleInteraction(payload);
    return body ? NextResponse.json(body) : new NextResponse(null, { status: 200 });
  } catch (err) {
    report(err, "slack.interaction", { type: payload.type });
    return new NextResponse("error", { status: 500 });
  }
}
