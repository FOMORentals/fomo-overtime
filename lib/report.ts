import * as Sentry from "@sentry/nextjs";

/** Log and send to Sentry (FOMO engineering rule 1). */
export function report(err: unknown, context: string, extra: Record<string, unknown> = {}) {
  console.error(`[overtime] ${context}`, err, extra);
  Sentry.captureException(err, { tags: { context }, extra });
}

export function appUrl(): string {
  return (process.env.APP_URL || "https://fomo-overtime.vercel.app").replace(/\/$/, "");
}
