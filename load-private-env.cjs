"use strict";

// Loads the Onboarding CRM, WorkDrive and application secrets from a PRIVATE file outside the web root, before the application bundle is imported.
// The cPanel Environment Variables page displays stored values, so secrets must not live there.
//
//   Location:  $S2F_PRIVATE_ENV_FILE (absolute path; not a secret) or ~/s2f-private/onboarding-staging.env
//   Format:    KEY=value lines (dotenv). Only the keys below are read; every other line is ignored.
//   Rules:     never overrides a variable that is already set; refuses a file readable by group/others (POSIX), a relative
//              path, or a file inside the application directory; never prints a value or the file contents.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnv } = require("node:util");

const ALLOWED = [
  "SIX2FIT_ZOHO_CLIENT_ID",
  "SIX2FIT_ZOHO_CLIENT_SECRET",
  "SIX2FIT_ZOHO_REFRESH_TOKEN",
  "SIX2FIT_WORKDRIVE_CLIENT_ID",
  "SIX2FIT_WORKDRIVE_CLIENT_SECRET",
  "SIX2FIT_WORKDRIVE_REFRESH_TOKEN",
  "SIX2FIT_ONBOARDING_TOKEN_SECRET",
  "SIX2FIT_OPS_CALLER_SECRET",
  // Not a secret, but JSON with double quotes is mangled by the cPanel SetEnv path (`\"`): write it single-quoted in the private file.
  "SIX2FIT_PRODUCT_SCOPE_MAP",
  "SIX2FIT_NOTION_TOKEN", // Notion integration token (test workspace); non-secret Notion settings stay in the host environment
];

function loadPrivateEnv(options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((m) => console.error(m));
  const appDir = options.appDir || __dirname;
  const configured = (env.S2F_PRIVATE_ENV_FILE || "").trim();
  const file = configured || path.join(options.home || os.homedir(), "s2f-private", "onboarding-staging.env");

  if (!path.isAbsolute(file)) return log("s2f private env: path must be absolute"), false;
  const rel = path.relative(appDir, file);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return log("s2f private env: file must be outside the application directory"), false;

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return log("s2f private env: file not found (CRM credentials not loaded)"), false;
  }
  if (!st.isFile()) return log("s2f private env: not a regular file"), false;
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) return log("s2f private env: refused, permissions too open (chmod 600)"), false;

  let parsed;
  try {
    parsed = parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return log("s2f private env: file could not be read or parsed"), false;
  }
  let loaded = 0;
  for (const key of ALLOWED) {
    const value = typeof parsed[key] === "string" ? parsed[key].trim() : "";
    if (value !== "" && (env[key] === undefined || env[key] === "")) {
      env[key] = value;
      loaded += 1;
    }
  }
  log(`s2f private env: ${loaded} of ${ALLOWED.length} variables loaded`);
  return true;
}

module.exports = { loadPrivateEnv, ALLOWED };
