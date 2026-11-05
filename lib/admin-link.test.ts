import { test } from "node:test";
import assert from "node:assert/strict";

test("admin link: genuine, admin-only, expires", async () => {
  process.env.AUTH_SECRET = "test-secret";
  const { signAdminToken, verifyAdminToken, TTL_MS } = await import("./admin-link");
  const now = 1_800_000_000_000;
  const t = signAdminToken("sam@fomorentals.co.uk", now);
  assert.equal(verifyAdminToken(t, now + 1000), "sam@fomorentals.co.uk");
  assert.equal(verifyAdminToken(t, now + TTL_MS + 1), null, "expired");
  assert.equal(verifyAdminToken(t.slice(0, -2) + "xx", now), null, "tampered");
  assert.equal(verifyAdminToken(signAdminToken("louis@fomorentals.co.uk", now), now), null, "not an admin");
  assert.equal(verifyAdminToken(null, now), null);
});
