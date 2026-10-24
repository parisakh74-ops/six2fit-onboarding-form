"use strict";

// cPanel-cron helper: continues every due Notion sync through the signed operations endpoint of THIS application.
//   node scripts/notion-reconcile.cjs            (reads SIX2FIT_OPS_CALLER_SECRET from the private env file, like the app)
// Prints counts and codes only (never a key, page id, answer or secret). Exit code 0 = request answered 200, 1 otherwise.
// The target defaults to the Staging origin; it must be an https origin of onboarding-staging.* and nothing else.
const { createHash, createHmac } = require("node:crypto");
const { loadPrivateEnv } = require("../load-private-env.cjs");

const PATH = "/api/internal/notion-reconcile";
const DEFAULT_ORIGIN = "https://onboarding-staging.6tofit.com";

function buildSignedRequest(secret, origin, body, nowSec) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("OPS_SECRET_MISSING");
  const u = new URL(origin);
  if (u.protocol !== "https:" || !u.hostname.startsWith("onboarding-staging.") || u.pathname !== "/") throw new Error("ORIGIN_REFUSED");
  const ts = String(nowSec);
  const sig = createHmac("sha256", secret).update(`${ts}.POST.${PATH}.${createHash("sha256").update(body).digest("hex")}`).digest("hex");
  return { url: `${u.origin}/?six2fit_api=notion-reconcile`, init: { method: "POST", body, headers: { "x-s2f-timestamp": ts, "x-s2f-signature": sig, "content-type": "application/json" } } };
}

async function main() {
  loadPrivateEnv();
  const secret = (process.env.SIX2FIT_OPS_CALLER_SECRET || "").trim();
  const origin = (process.env.S2F_RECONCILE_ORIGIN || DEFAULT_ORIGIN).trim();
  const body = JSON.stringify({ limit: 20 });
  const { url, init } = buildSignedRequest(secret, origin, body, Math.floor(Date.now() / 1000));
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  console.log(`notion-reconcile http=${res.status} ${res.ok ? text.slice(0, 400) : ""}`);
  return res.ok ? 0 : 1;
}

module.exports = { buildSignedRequest };
if (require.main === module) main().then((c) => process.exit(c), () => (console.log("notion-reconcile failed"), process.exit(1)));
