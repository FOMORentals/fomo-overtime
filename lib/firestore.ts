import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/** Same Firestore and credential pattern as the other FOMO Vercel apps; this app only uses ot_* collections. */
export function db(): Firestore {
  if (getApps().length === 0 && process.env.FIRESTORE_EMULATOR_HOST) {
    initializeApp({ projectId: "demo-ot" }); // local tests only (npm run test:db)
  }
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set");
    const serviceAccount = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    initializeApp({ credential: cert(serviceAccount) });
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
