// @vitest-environment node
// Loader compatibility (load-private-env.cjs): allowlist, quoting of the product map, and the unchanged security rules.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { productMapFromEnv } from "./onboarding/links/product-map";

const { loadPrivateEnv, ALLOWED } = createRequire(import.meta.url)("../../load-private-env.cjs") as {
  loadPrivateEnv: (o: { env: Record<string, string | undefined>; log: (m: string) => void; appDir: string; home?: string }) => boolean;
  ALLOWED: string[];
};

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "s2f-onb-penv-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

const MAP = '{"6223361000127336001":{"scope":"Combo","entitlements":["cellulite"]}}';
const SECRET = "synthetic-onboarding-secret-0123456789abcdef";
const body = [
  "SIX2FIT_ZOHO_CLIENT_ID=cid", "SIX2FIT_ZOHO_CLIENT_SECRET=csec", "SIX2FIT_ZOHO_REFRESH_TOKEN=crt",
  "SIX2FIT_WORKDRIVE_CLIENT_ID=wid", "SIX2FIT_WORKDRIVE_CLIENT_SECRET=wsec", "SIX2FIT_WORKDRIVE_REFRESH_TOKEN=wrt",
  `SIX2FIT_ONBOARDING_TOKEN_SECRET=${SECRET}`, "SIX2FIT_OPS_CALLER_SECRET=ops",
  `SIX2FIT_PRODUCT_SCOPE_MAP='${MAP}'`, "SIX2FIT_NOTION_TOKEN=secret_synthetic_notion_0123456789",
  "SIX2FIT_ZOHO_ENVIRONMENT=production", "SIX2FIT_STAGING_MODE=false", "OTHER=x", "",
].join("\n");

function setup(content = body) {
  const app = tmp(), priv = tmp();
  const file = join(priv, "onboarding.env");
  writeFileSync(file, content);
  if (process.platform !== "win32") chmodSync(file, 0o600);
  const logs: string[] = [];
  return { app, file, logs, log: (m: string) => logs.push(m) };
}

describe("onboarding private env loader", () => {
  it("the allowlist is exactly the eight credentials, the product map and the Notion token", () => {
    expect([...ALLOWED].sort()).toEqual([
      "SIX2FIT_NOTION_TOKEN", "SIX2FIT_ONBOARDING_TOKEN_SECRET", "SIX2FIT_OPS_CALLER_SECRET", "SIX2FIT_PRODUCT_SCOPE_MAP", "SIX2FIT_WORKDRIVE_CLIENT_ID",
      "SIX2FIT_WORKDRIVE_CLIENT_SECRET", "SIX2FIT_WORKDRIVE_REFRESH_TOKEN", "SIX2FIT_ZOHO_CLIENT_ID", "SIX2FIT_ZOHO_CLIENT_SECRET", "SIX2FIT_ZOHO_REFRESH_TOKEN",
    ].sort());
  });
  it("loads a single-quoted JSON product map intact, and the runtime parser accepts it (cellulite Combo)", () => {
    const s = setup();
    const env: Record<string, string | undefined> = { S2F_PRIVATE_ENV_FILE: s.file };
    expect(loadPrivateEnv({ env, log: s.log, appDir: s.app })).toBe(true);
    expect(env["SIX2FIT_PRODUCT_SCOPE_MAP"]).toBe(MAP);
    expect(productMapFromEnv(env["SIX2FIT_PRODUCT_SCOPE_MAP"]).map({ id: "6223361000127336001" })).toMatchObject({ scope: "Combo", entitlements: ["cellulite"] });
    expect(s.logs.join("\n")).toContain("10 of 10 variables loaded");
  });
  it("security rules are unchanged: other keys ignored, nothing overridden, no value logged", () => {
    const s = setup();
    const env: Record<string, string | undefined> = { S2F_PRIVATE_ENV_FILE: s.file, SIX2FIT_ZOHO_ENVIRONMENT: "sandbox", SIX2FIT_ZOHO_CLIENT_ID: "existing", SIX2FIT_PRODUCT_SCOPE_MAP: "{}" };
    loadPrivateEnv({ env, log: s.log, appDir: s.app });
    expect(env["SIX2FIT_ZOHO_ENVIRONMENT"]).toBe("sandbox");
    expect(env["SIX2FIT_STAGING_MODE"]).toBeUndefined();
    expect(env["OTHER"]).toBeUndefined();
    expect(env["SIX2FIT_ZOHO_CLIENT_ID"]).toBe("existing");
    expect(env["SIX2FIT_PRODUCT_SCOPE_MAP"]).toBe("{}"); // a value already set (e.g. by the host) always wins
    const logged = s.logs.join("\n");
    for (const v of [SECRET, "csec", "wsec", "wrt", MAP, "secret_synthetic_notion"]) expect(logged).not.toContain(v);
  });
  it("refuses a relative path, a file inside the application directory, and a missing file loads nothing", () => {
    const s = setup();
    expect(loadPrivateEnv({ env: { S2F_PRIVATE_ENV_FILE: "relative.env" }, log: s.log, appDir: s.app })).toBe(false);
    const inside = join(s.app, "secret.env");
    writeFileSync(inside, body);
    const env: Record<string, string | undefined> = { S2F_PRIVATE_ENV_FILE: inside };
    expect(loadPrivateEnv({ env, log: s.log, appDir: s.app })).toBe(false);
    expect(env["SIX2FIT_PRODUCT_SCOPE_MAP"]).toBeUndefined();
    const none: Record<string, string | undefined> = {};
    expect(loadPrivateEnv({ env: none, log: s.log, appDir: s.app, home: s.app })).toBe(false);
  });
  it.skipIf(process.platform === "win32")("refuses a file readable by group or others", () => {
    const s = setup();
    chmodSync(s.file, 0o644);
    const env: Record<string, string | undefined> = { S2F_PRIVATE_ENV_FILE: s.file };
    expect(loadPrivateEnv({ env, log: s.log, appDir: s.app })).toBe(false);
    expect(env["SIX2FIT_PRODUCT_SCOPE_MAP"]).toBeUndefined();
  });
});
