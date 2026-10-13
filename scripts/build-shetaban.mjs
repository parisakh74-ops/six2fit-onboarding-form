import { spawnSync } from "node:child_process";

const viteEntry = "node_modules/vite/bin/vite.js"; // run through node: no shell or .cmd shim needed on any platform

// The ShetabanHost startup file (passenger.cjs) expects a `middleware` export, i.e. the Nitro `node-middleware` preset
// (verified on the host, 2026-10-13: nitro.json preset "node-middleware"). Override with NITRO_PRESET only knowingly.
const preset = process.env.NITRO_PRESET || "node-middleware";

// Build id baked into the bundle: the git commit, "-dirty" if the tree has changes.
let buildId = process.env.VITE_BUILD_ID || "unknown";
if (!process.env.VITE_BUILD_ID) {
  const run = (args) => spawnSync("git", args, { encoding: "utf8" });
  const sha = run(["rev-parse", "--short", "HEAD"]);
  if (sha.status === 0) {
    const dirty = run(["status", "--porcelain"]);
    buildId = sha.stdout.trim() + (dirty.status === 0 && dirty.stdout.trim() ? "-dirty" : "");
  }
}

const result = spawnSync(process.execPath, [viteEntry, "build", "--mode", "staging"], {
  stdio: "inherit",
  env: { ...process.env, NITRO_PRESET: preset, VITE_BUILD_ID: buildId },
});

if (result.error) console.error("build failed to start:", result.error.message);
if (result.status === 0) console.log(`built preset=${preset} build=${buildId}`);
process.exit(result.status ?? 1);
