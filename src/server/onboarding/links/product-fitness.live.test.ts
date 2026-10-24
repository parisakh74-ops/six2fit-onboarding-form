// @vitest-environment node
// OPERATOR-RUN, READ-ONLY: proves the CURRENT Zoho CRM Sandbox credentials can read Product.Fitness through the real reader
// (Deal -> Product -> Fitness). Performs GET requests only (token refresh + three reads). Nothing is written, nothing is deleted.
// Skipped unless S2F_FITNESS_LIVE=1 and S2F_FITNESS_CONFIRM=S2F-READ-PRODUCT-FITNESS; the environment guard of the client refuses a
// non-Sandbox organisation. Only categories are recorded (read allowed / denied / unavailable, value class); no credential, no name.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrmReadError } from "./types";
import { createCrmReader } from "./crm-reader";

const env = process.env as Record<string, string | undefined>;
const ON = env["S2F_FITNESS_LIVE"] === "1" && env["S2F_FITNESS_CONFIRM"] === "S2F-READ-PRODUCT-FITNESS" && env["SIX2FIT_ZOHO_ENVIRONMENT"] === "sandbox";
const DEAL = (env["S2F_LIVE_DEAL_ID"] ?? "").trim();
const result: Record<string, unknown> = {};

describe.skipIf(!ON)("Sandbox credentials can read Product.Fitness (read-only)", () => {
  it("Deal -> Product -> Fitness", async () => {
    expect(DEAL).toMatch(/^6223361000\d{9}$/);
    const { reader, sharedGrant } = createCrmReader(env);
    result["grant"] = sharedGrant ? "shared-with-writer" : "dedicated-reader";
    try {
      const deal = await reader.getDeal(DEAL);
      result["deal_read"] = !!deal;
      result["product_linked"] = !!deal?.productId;
      expect(deal?.productId).toBeTruthy();
      const fitness = await reader.getProductFitness(deal!.productId as string);
      result["products_read"] = "allowed";
      result["fitness_value_class"] = fitness === null ? "empty" : ["Normal", "VIP", "VIP - Cellulite"].includes(fitness) ? fitness : "other";
    } catch (e) {
      result["products_read"] = e instanceof CrmReadError ? e.code : "error";
      throw e;
    } finally {
      writeFileSync(join(tmpdir(), "s2f_product_fitness_result.json"), JSON.stringify(result, null, 1) + "\n");
    }
  }, 120_000);
});
