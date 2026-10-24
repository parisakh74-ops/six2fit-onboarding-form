// @vitest-environment node
// OPERATOR-RUN, READ-ONLY: proves the CURRENT Zoho CRM Sandbox credentials can read Product.Fitness (Deal -> Product -> Fitness).
// GET requests only (token refresh, environment verification, three reads). Nothing is written or deleted.
// Skipped unless S2F_FITNESS_LIVE=1 and S2F_FITNESS_CONFIRM=S2F-READ-PRODUCT-FITNESS and the environment is the Sandbox.
// The result file records ONE category (see ProbeCategory) plus the HTTP status class; never a credential, name or value.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZohoClient } from "../crm/client";
import { loadCrmConfig } from "../crm/config";
import { createCrmReader } from "./crm-reader";
import { CATEGORY_MESSAGE, classifyProductResponse, classifyStoreError, type ProbeCategory } from "./product-fitness-probe";

const env = process.env as Record<string, string | undefined>;
const ON = env["S2F_FITNESS_LIVE"] === "1" && env["S2F_FITNESS_CONFIRM"] === "S2F-READ-PRODUCT-FITNESS" && env["SIX2FIT_ZOHO_ENVIRONMENT"] === "sandbox";
const DEAL = (env["S2F_LIVE_DEAL_ID"] ?? "").trim();
const OUT = join(tmpdir(), "s2f_product_fitness_result.json");

describe.skipIf(!ON)("Sandbox credentials can read Product.Fitness (read-only)", () => {
  it("Deal -> Product -> Fitness, with a precise category for every way it can fail", async () => {
    const result: Record<string, unknown> = { category: "UNEXPECTED_RESPONSE" as ProbeCategory };
    const finish = (category: ProbeCategory, extra: Record<string, unknown> = {}) => {
      Object.assign(result, { category, meaning: CATEGORY_MESSAGE[category] }, extra);
      writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
      return category;
    };
    expect(DEAL).toMatch(/^6223361000\d{9}$/);

    // 1. configuration (no request is made)
    let config;
    try {
      config = loadCrmConfig(env);
    } catch (e) {
      expect(finish(classifyStoreError(e))).toBe("SUCCESS");
      return;
    }

    // 2. authentication + environment guard (token refresh, organisation and module checks)
    const client = new ZohoClient(config, { fetch: globalThis.fetch as never, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    try {
      await client.verifyEnvironment();
    } catch (e) {
      expect(finish(classifyStoreError(e))).toBe("SUCCESS");
      return;
    }

    // 3. the Deal (needs the Deals read scope) and its Product
    const { reader, sharedGrant } = createCrmReader(env);
    result["grant"] = sharedGrant ? "shared-with-writer" : "dedicated-reader";
    let productId: string | null = null;
    try {
      productId = (await reader.getDeal(DEAL))?.productId ?? null;
    } catch {
      expect(finish("DEAL_NOT_READABLE")).toBe("SUCCESS");
      return;
    }
    if (!productId) {
      expect(finish("DEAL_NOT_READABLE", { detail: "the Deal has no Product" })).toBe("SUCCESS");
      return;
    }

    // 4. the raw Products read, classified by what Zoho answers
    const raw = await client.request("GET", `/Products/${productId}`, { query: { fields: "id,Fitness" } });
    const category = classifyProductResponse(raw, productId);
    result["products_http_class"] = `${Math.floor(raw.status / 100)}xx`;
    if (category !== "SUCCESS") {
      expect(finish(category)).toBe("SUCCESS");
      return;
    }

    // 5. the application's own code path must agree with the raw read
    const fitness = await reader.getProductFitness(productId);
    expect(finish("SUCCESS", { fitness_value_class: fitness === null ? "empty" : ["Normal", "VIP", "VIP - Cellulite"].includes(fitness) ? fitness : "other" })).toBe("SUCCESS");
  }, 120_000);
});
