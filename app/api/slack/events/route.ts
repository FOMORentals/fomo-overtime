import { after, NextResponse } from "next/server";
import { publishHome } from "@/lib/actions";
import { report } from "@/lib/report";
import { verifySlackSignature } from "@/lib/slack";

export const maxDuration = 60;

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySlackSignature(raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature")))
    return new NextResponse("bad signature", { status: 401 });
  const body = JSON.parse(raw);
  if (body.type === "url_verification") return NextResponse.json({ challenge: body.challenge });
  const ev = body.event;
  if (ev?.type === "app_home_opened" && ev.tab === "home") {
    after(() => publishHome(ev.user).catch((e) => report(e, "home.publish", { user: ev.user })));
  }
  return new NextResponse(null, { status: 200 });
}
