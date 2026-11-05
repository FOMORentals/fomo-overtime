import type { SlotInput } from "./types";

export function slotLabel(s: Pick<SlotInput, "kind" | "title" | "rentmanJob">): string {
  return [s.kind, s.title, s.rentmanJob ? `#${s.rentmanJob}` : ""].filter(Boolean).join(" · ");
}
