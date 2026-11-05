import { NextResponse } from "next/server";
import { adminEmail } from "@/lib/admin-session";
import { payRunCsv } from "@/lib/rules";
import { claimsByIds, claimsInMonth, getPayRun } from "@/lib/store";

/** CSV for payroll. ?run=YYYY-MM (a pay run) or ?month=YYYY-MM (every counted claim that month). Admins only. */
export async function GET(req: Request) {
  if (!(await adminEmail())) return new NextResponse("Admins only. Open this from the Overtime app in Slack.", { status: 403 });
  const url = new URL(req.url);
  const run = url.searchParams.get("run");
  const month = url.searchParams.get("month");
  let claims;
  let name;
  if (run && /^\d{4}-\d{2}$/.test(run)) {
    const pr = await getPayRun(run);
    if (!pr) return new NextResponse("No pay run for that month.", { status: 404 });
    claims = await claimsByIds(pr.claimIds);
    name = `overtime-payrun-${run}.csv`;
  } else if (month && /^\d{4}-\d{2}$/.test(month)) {
    claims = (await claimsInMonth(month)).filter((c) => c.status === "completed" && !c.flagged && c.amountPence > 0);
    name = `overtime-${month}.csv`;
  } else return new NextResponse("Add ?month=YYYY-MM or ?run=YYYY-MM", { status: 400 });
  return new NextResponse(payRunCsv(claims), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
}
