import { MemWal } from "@mysten-incubation/memwal";

const RELAYER = process.env.MEMWAL_RELAYER || "https://relayer-staging.memory.walrus.xyz";
const NAMESPACE = process.env.MEMWAL_NAMESPACE || "slack";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";

let memwal;
const channelNames = new Map();
const userNames = new Map();
const messageLinks = new Map();
const isChannelId = (value) => /^[CGD][A-Z0-9]+$/.test(String(value || ""));
const isUserId = (value) => /^[UW][A-Z0-9]+$/.test(String(value || ""));

export function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

export function deploymentHealth() {
  const missing = ["MEMWAL_ACCOUNT_ID", "MEMWAL_KEY"].filter((key) => !process.env[key]);
  return {
    ok: missing.length === 0,
    namespace: NAMESPACE,
    relayer: RELAYER,
    account: process.env.MEMWAL_ACCOUNT_ID
      ? `${process.env.MEMWAL_ACCOUNT_ID.slice(0, 10)}…`
      : "not configured",
    slackMetadata: Boolean(SLACK_TOKEN),
    ...(missing.length && { missing }),
  };
}

function getMemwal() {
  const health = deploymentHealth();
  if (!health.ok) throw new Error(`Missing Vercel environment variables: ${health.missing.join(", ")}`);
  memwal ||= MemWal.create({
    key: process.env.MEMWAL_KEY,
    accountId: process.env.MEMWAL_ACCOUNT_ID,
    serverUrl: RELAYER,
    namespace: NAMESPACE,
  });
  return memwal;
}

async function slack(method, params) {
  if (!SLACK_TOKEN) throw new Error("SLACK_BOT_TOKEN is not configured");
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `Slack ${method} failed`);
  return data;
}

function cachedLookup(cache, key, load) {
  if (cache.has(key)) return cache.get(key);
  const lookup = load().catch((error) => {
    cache.delete(key);
    console.warn(`Slack metadata lookup failed for ${key}:`, error?.message || error);
    return key;
  });
  cache.set(key, lookup);
  return lookup;
}

function resolveChannel(channelId) {
  if (!isChannelId(channelId) || !SLACK_TOKEN) return channelId;
  return cachedLookup(channelNames, channelId, async () => {
    const result = await slack("conversations.info", { channel: channelId });
    return result.channel?.name || channelId;
  });
}

function resolveUser(userId) {
  if (!isUserId(userId) || !SLACK_TOKEN) return userId;
  return cachedLookup(userNames, userId, async () => {
    const result = await slack("users.info", { user: userId });
    const slackUser = result.user;
    return slackUser?.profile?.real_name_normalized
      || slackUser?.profile?.real_name
      || slackUser?.real_name
      || slackUser?.profile?.display_name_normalized
      || slackUser?.profile?.display_name
      || slackUser?.name
      || userId;
  });
}

function resolvePermalink(channelId, messageTs) {
  if (!isChannelId(channelId) || !messageTs || !SLACK_TOKEN) return "";
  const key = `${channelId}:${messageTs}`;
  return cachedLookup(messageLinks, key, async () => {
    const result = await slack("chat.getPermalink", { channel: channelId, message_ts: messageTs });
    return result.permalink || "";
  });
}

async function enrichSlackMemory(item) {
  if (!item || typeof item !== "object" || typeof item.text !== "string") return item;
  let memory;
  try { memory = JSON.parse(item.text); } catch { return item; }
  if (!memory || typeof memory !== "object" || memory.source !== "slack") return item;

  const channelId = memory.channel_id || (isChannelId(memory.channel) ? memory.channel : "");
  const userId = memory.user_id || (isUserId(memory.user) ? memory.user : "");
  const [channel, user, url] = await Promise.all([
    channelId ? resolveChannel(channelId) : memory.channel,
    userId ? resolveUser(userId) : memory.user,
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

export async function recallMemories(query) {
  const result = await getMemwal().recall({ query });
  return Promise.all((result.results || []).map(enrichSlackMemory));
}
