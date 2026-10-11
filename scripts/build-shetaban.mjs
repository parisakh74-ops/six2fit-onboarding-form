import { spawnSync } from "node:child_process";

const vite = process.platform === "win32"
  ? "node_modules/.bin/vite.cmd"
  : "node_modules/.bin/vite";

const result = spawnSync(vite, ["build", "--mode", "staging"], {
  stdio: "inherit",
  env: { ...process.env, NITRO_PRESET: "node-server" },
});

process.exit(result.status ?? 1);
