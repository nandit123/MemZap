import { json, recallMemories } from "../lib/memory-api.js";

export async function GET(request) {
  try {
    const query = new URL(request.url).searchParams.get("q") || "notes decisions updates information";
    return json({ results: await recallMemories(query) });
  } catch (error) {
    console.error("Vercel recall API error:", error);
    return json({ error: error?.message || String(error) }, 500);
  }
}
