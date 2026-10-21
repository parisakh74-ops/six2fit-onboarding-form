"use strict";

// Matches the file deployed on ShetabanHost (2026-10-11): requires the Nitro `node-middleware` build
// (`npm run build:shetaban`), which exports `middleware`.
const { createServer } = require("node:http");
const { loadPrivateEnv } = require("./load-private-env.cjs");
loadPrivateEnv();

void import("./.output/server/index.mjs")
  .then(({ middleware }) => {
    const port = Number.parseInt(process.env.PORT || "3000", 10);
    createServer(middleware).listen(port);
  })
  .catch((error) => {
    console.error("Failed to start Six2Fit Onboarding", error);
    process.exitCode = 1;
  });
