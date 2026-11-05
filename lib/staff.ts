/**
 * Who can use the tool (agreed with Jamie, 5 Nov 2026). Matched on the Slack account's
 * fomorentals.co.uk email. To add or remove someone, edit this list and redeploy.
 */
export interface StaffMember {
  email: string;
  name: string;
  admin: boolean;
}

export const STAFF: StaffMember[] = [
  { email: "sam@fomorentals.co.uk", name: "Sam", admin: true },
  { email: "jamie@fomorentals.co.uk", name: "Jamie", admin: true },
  { email: "louis@fomorentals.co.uk", name: "Louis", admin: false },
  { email: "rosie@fomorentals.co.uk", name: "Rosie", admin: false },
  { email: "will@fomorentals.co.uk", name: "Will", admin: false },
  { email: "margarita@fomorentals.co.uk", name: "Margarita", admin: false },
];

/** Sam approves the month-end summary; Jamie forwards it to Mark's team. */
export const APPROVER_EMAIL = "sam@fomorentals.co.uk";
export const PAYROLL_SENDER_EMAIL = "jamie@fomorentals.co.uk";
/** Gets drop-out and unclaimed-slot alerts. */
export const OPS_ALERT_EMAIL = "sam@fomorentals.co.uk";

export function staffByEmail(email: string | null | undefined): StaffMember | null {
  const e = (email ?? "").trim().toLowerCase();
  return STAFF.find((s) => s.email === e) ?? null;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  return staffByEmail(email)?.admin ?? false;
}
