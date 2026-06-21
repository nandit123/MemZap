import { deploymentHealth, json } from "../lib/memory-api.js";

export function GET() {
  const health = deploymentHealth();
  return json(health, health.ok ? 200 : 503);
}
