// MemZap bridge — Slack write path + local API the dashboard reads from.
// Run:  npm i @slack/bolt @mysten-incubation/memwal
//       node --env-file=.env server.mjs
//
// The delegate key stays in this process. The dashboard only ever talks to
// http://localhost:8787 — it never sees your key.

import { App } from "@slack/bolt";
import { MemWal } from "@mysten-incubation/memwal";
import http from "node:http";

const RELAYER   = process.env.MEMWAL_RELAYER   || "https://relayer-staging.memory.walrus.xyz"; // testnet
const NAMESPACE = process.env.MEMWAL_NAMESPACE || "slack";
const API_PORT  = Number(process.env.MEMZAP_API_PORT || 8787);

const memwal = MemWal.create({
  key:       process.env.MEMWAL_KEY,
  accountId: process.env.MEMWAL_ACCOUNT_ID,
  serverUrl: RELAYER,
  namespace: NAMESPACE,
});

/* ----------------------------- Slack (write) ----------------------------- */
const app = new App({
  token:         process.env.SLACK_BOT_TOKEN,
  appToken:      process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode:    true,
});

app.event("app_mention", async ({ event, client }) => {
  const text = event.text.replace(/<@[^>]+>\s*/, "").replace(/^remember\s*/i, "").trim();

  // best-effort: resolve readable channel + user names and a permalink
  let channel = event.channel, user = event.user, url = "";
  try { url = (await client.chat.getPermalink({ channel: event.channel, message_ts: event.ts })).permalink; } catch {}
  try { const c = await client.conversations.info({ channel: event.channel }); if (c.channel?.name) channel = c.channel.name; } catch {}
  try { const u = await client.users.info({ user: event.user }); if (u.user?.name) user = u.user.name; } catch {}

  const job = await memwal.remember(JSON.stringify({
    text, source: "slack", channel, user, ts: event.ts, url,
  }));
  await memwal.waitForRememberJob(job.job_id);
  await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "white_check_mark" });
  console.log(`remembered from #${channel} by @${user}: ${text.slice(0, 60)}`);
});

/* --------------------------- Local API (read/write) ---------------------- */
const cors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
};
const send = (res, code, obj) => { res.writeHead(code); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return send(res, 204, {});
  const u = new URL(req.url, `http://localhost:${API_PORT}`);
  try {
    if (u.pathname === "/health") {
      return send(res, 200, {
        ok: true,
        namespace: NAMESPACE,
        relayer: RELAYER,
        account: (process.env.MEMWAL_ACCOUNT_ID || "").slice(0, 10) + "…",
      });
    }
    // recent feed + semantic recall share one handler
    if (u.pathname === "/memories" || u.pathname === "/recall") {
      const q = u.searchParams.get("q") || "notes decisions updates information";
      const r = await memwal.recall({ query: q });
      return send(res, 200, { results: r.results ?? r ?? [] });
    }
    // optional: write a memory straight from the dashboard
    if (u.pathname === "/remember" && req.method === "POST") {
      const b = await readBody(req);
      if (!b.text) return send(res, 400, { error: "text required" });
      const job = await memwal.remember(JSON.stringify({
        text: b.text, source: "dashboard",
        channel: b.channel || "dashboard", user: b.user || "you",
        ts: String(Date.now() / 1000), url: "",
      }));
      await memwal.waitForRememberJob(job.job_id);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("API error:", e);
    return send(res, 500, { error: String(e?.message || e) });
  }
}).listen(API_PORT, () => console.log(`MemZap API → http://localhost:${API_PORT}`));

/* --------------------------------- start --------------------------------- */
await app.start();
console.log(`MemZap bridge live → namespace "${NAMESPACE}" @ ${RELAYER}`);
