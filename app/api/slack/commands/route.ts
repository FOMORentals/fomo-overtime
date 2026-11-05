import { NextResponse } from "next/server";
import { handleCommand } from "@/lib/handlers";
import { report } from "@/lib/report";
import { verifySlackSignature } from "@/lib/slack";

export const maxDuration = 60;

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySlackSignature(raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature")))
    return new NextResponse("bad signature", { status: 401 });
  try {
    const body = await handleCommand(new URLSearchParams(raw));
    return body.text === "" ? new NextResponse(null, { status: 200 }) : NextResponse.json(body);
  } catch (err) {
    report(err, "slack.command");
    return NextResponse.json({ response_type: "ephemeral", text: "Something went wrong. Please try again." });
  }
}
