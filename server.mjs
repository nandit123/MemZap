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
const REMEMBER_TIMEOUT_MS = Number(process.env.MEMZAP_REMEMBER_TIMEOUT_MS || 300_000);
const REMEMBER_POLL_MS = Number(process.env.MEMZAP_REMEMBER_POLL_MS || 500);

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

const channelNames = new Map();
const userNames = new Map();
const messageLinks = new Map();
const isChannelId = (value) => /^[CGD][A-Z0-9]+$/.test(String(value || ""));
const isUserId = (value) => /^[UW][A-Z0-9]+$/.test(String(value || ""));

async function resolveChannelName(channelId, client = app.client) {
  if (!isChannelId(channelId)) return channelId;
  if (channelNames.has(channelId)) return channelNames.get(channelId);
  const lookup = (async () => {
    try {
      const result = await client.conversations.info({ channel: channelId });
      const name = result.channel?.name || channelId;
      return name;
    } catch (error) {
      channelNames.delete(channelId);
      console.warn(`Could not resolve Slack channel ${channelId}. Check the channels:read scope.`, error?.data?.error || error?.message || error);
      return channelId;
    }
  })();
  channelNames.set(channelId, lookup);
  return lookup;
}

async function resolveUserName(userId, client = app.client) {
  if (!isUserId(userId)) return userId;
  if (userNames.has(userId)) return userNames.get(userId);
  const lookup = (async () => {
    try {
      const result = await client.users.info({ user: userId });
      const slackUser = result.user;
      return slackUser?.profile?.real_name_normalized
        || slackUser?.profile?.real_name
        || slackUser?.real_name
        || slackUser?.profile?.display_name_normalized
        || slackUser?.profile?.display_name
        || slackUser?.name
        || userId;
    } catch (error) {
      userNames.delete(userId);
      console.warn(`Could not resolve Slack user ${userId}. Check the users:read scope.`, error?.data?.error || error?.message || error);
      return userId;
    }
  })();
  userNames.set(userId, lookup);
  return lookup;
}

async function resolvePermalink(channelId, messageTs, client = app.client) {
  if (!isChannelId(channelId) || !messageTs) return "";
  const key = `${channelId}:${messageTs}`;
  if (messageLinks.has(key)) return messageLinks.get(key);
  const lookup = (async () => {
    try {
      const result = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
      return result.permalink || "";
    } catch (error) {
      messageLinks.delete(key);
      console.warn(`Could not resolve Slack permalink for ${channelId}:`, error?.data?.error || error?.message || error);
      return "";
    }
  })();
  messageLinks.set(key, lookup);
  return lookup;
}

async function enrichSlackMemory(item) {
  if (!item || typeof item !== "object" || typeof item.text !== "string") return item;
  let memory;
  try { memory = JSON.parse(item.text); } catch { return item; }
  if (!memory || typeof memory !== "object" || memory.source !== "slack") return item;

  const channelId = memory.channel_id || (isChannelId(memory.channel) ? memory.channel : "");
  const userId = memory.user_id || (isUserId(memory.user) ? memory.user : "");
  const [channel, user, url] = await Promise.all([
    channelId ? resolveChannelName(channelId) : memory.channel,
    userId ? resolveUserName(userId) : memory.user,
    memory.url || (channelId && memory.ts ? resolvePermalink(channelId, memory.ts) : ""),
  ]);

  return {
    ...item,
    text: JSON.stringify({
      ...memory,
      channel: channel || memory.channel,
      user: user || memory.user,
      url: url || memory.url || "",
      ...(channelId && { channel_id: channelId }),
      ...(userId && { user_id: userId }),
    }),
  };
}

async function setReaction(client, event, name, remove = false) {
  try {
    const args = { channel: event.channel, timestamp: event.ts, name };
    if (remove) await client.reactions.remove(args);
    else await client.reactions.add(args);
  } catch (error) {
    const code = error?.data?.error;
    if (code !== "already_reacted" && code !== "no_reaction") {
      console.warn(`Could not ${remove ? "remove" : "add"} Slack reaction ${name}:`, code || error?.message || error);
    }
  }
}

async function postStatusMessage(client, event, text) {
  try {
    const message = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text,
    });
    return message.ts || "";
  } catch (error) {
    console.warn("Could not post Slack status message:", error?.data?.error || error?.message || error);
    return "";
  }
}

async function updateStatusMessage(client, event, messageTs, text) {
  if (!messageTs) return;
  try {
    await client.chat.update({ channel: event.channel, ts: messageTs, text });
  } catch (error) {
    console.warn("Could not update Slack status message:", error?.data?.error || error?.message || error);
  }
}

async function trackRememberJob(jobId, event, client, originPromise, statusMessageTs, startedAt) {
  try {
    await memwal.waitForRememberJob(jobId, {
      pollIntervalMs: REMEMBER_POLL_MS,
      timeoutMs: REMEMBER_TIMEOUT_MS,
    });
    const origin = await originPromise;
    await setReaction(client, event, "hourglass_flowing_sand", true);
    await setReaction(client, event, "white_check_mark");
    await updateStatusMessage(
      client,
      event,
      statusMessageTs,
      `✅ Saved to shared memory from #${origin.channel} by ${origin.user}.`,
    );
    console.log(`remembered in ${((Date.now() - startedAt) / 1000).toFixed(1)}s from #${origin.channel} by ${origin.user}: ${origin.text.slice(0, 60)}`);
  } catch (error) {
    await setReaction(client, event, "hourglass_flowing_sand", true);
    await setReaction(client, event, "warning");
    const message = error?.status === 504
      ? `⚠️ Walrus accepted this memory, but confirmation is still pending (job ${jobId}). Check the dashboard before sending it again.`
      : `⚠️ Walrus could not save this memory (job ${jobId}). Check the MemZap server log for details.`;
    await updateStatusMessage(client, event, statusMessageTs, message);
    console.error(`Could not confirm remember job ${jobId}:`, error?.message || error);
  }
}

app.event("app_mention", async ({ event, client }) => {
  let statusMessageTs = "";
  try {
    const text = event.text.replace(/<@[^>]+>\s*/, "").replace(/^remember\s*/i, "").trim();
    const startedAt = Date.now();

    // Submit to Walrus first. Slack metadata is resolved afterward and on read.
    const rememberResult = memwal.remember(JSON.stringify({
      text, source: "slack",
      channel: event.channel, channel_id: event.channel,
      user: event.user, user_id: event.user,
      ts: event.ts, url: "",
    })).then(
      (job) => ({ job, acceptedAt: Date.now() }),
      (error) => ({ error }),
    );
    const originPromise = Promise.all([
      resolveChannelName(event.channel, client),
      resolveUserName(event.user, client),
    ]).then(([channel, user]) => ({ channel, user, text }));

    await setReaction(client, event, "hourglass_flowing_sand");
    statusMessageTs = await postStatusMessage(client, event, "⏳ Saving this memory to Walrus…");

    const result = await rememberResult;
    if (result.error) throw result.error;
    void trackRememberJob(result.job.job_id, event, client, originPromise, statusMessageTs, startedAt);
    void originPromise.then((origin) => {
      console.log(`queued remember job ${result.job.job_id} in ${result.acceptedAt - startedAt}ms from #${origin.channel} by ${origin.user}`);
    });
  } catch (error) {
    await setReaction(client, event, "hourglass_flowing_sand", true);
    await setReaction(client, event, "warning");
    await updateStatusMessage(client, event, statusMessageTs, "⚠️ MemZap could not submit this memory to Walrus. Check the server log for details.");
    console.error("Could not queue Slack memory:", error?.message || error);
  }
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
      const results = await Promise.all((r.results ?? r ?? []).map(enrichSlackMemory));
      return send(res, 200, { results });
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
