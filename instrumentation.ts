import * as Sentry from "@sentry/nextjs";

export async function register() {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0, environment: process.env.VERCEL_ENV ?? "development" });
}

export const onRequestError = Sentry.captureRequestError;
