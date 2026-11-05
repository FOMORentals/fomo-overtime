import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/** Same Firestore as the other FOMO Vercel apps (project fomo-bookings-board-v2); this app only uses ot_* collections. */
export function db(): Firestore {
  if (getApps().length === 0 && process.env.FIRESTORE_EMULATOR_HOST) {
    initializeApp({ projectId: "demo-ot" }); // local tests only (npm run test:db)
  }
  if (getApps().length === 0) {
    // One service account (overtime-app@clever-acolyte-298614, granted Cloud Datastore User on fomo-bookings-board-v2) does Firestore and Calendar.
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_BASE64 is not set");
    const serviceAccount = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    // Always the team dashboard's Firestore, even if the key was made in another Google project.
    initializeApp({ credential: cert(serviceAccount), projectId: process.env.FIRESTORE_PROJECT_ID || "fomo-bookings-board-v2" });
  }
  return getFirestore();
}

export const COL = {
  slots: "ot_slots",
  claims: "ot_claims",
  payRuns: "ot_pay_runs",
  audit: "ot_audit",
  meta: "ot_meta",
} as const;
