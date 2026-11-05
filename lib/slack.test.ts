import { test } from "node:test";
import assert from "node:assert/strict";

test("Slack calls are form-encoded so read methods get their arguments", async () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  const { slack } = await import("./slack");
  const seen: { url: string; type: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, type: String((init.headers as Record<string, string>)["Content-Type"]), body: String(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    await slack("users.info", { user: "U8ZB15F5K" });
    await slack("chat.postMessage", { channel: "C1", text: "hi", blocks: [{ type: "divider" }], thread_ts: undefined });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen[0].type, "application/x-www-form-urlencoded");
  assert.equal(seen[0].body, "user=U8ZB15F5K");
  const p = new URLSearchParams(seen[1].body);
  assert.deepEqual(JSON.parse(p.get("blocks")!), [{ type: "divider" }]);
  assert.equal(p.has("thread_ts"), false);
});
