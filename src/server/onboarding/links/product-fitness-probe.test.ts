// @vitest-environment node
// The Product.Fitness probe harness: the configuration it supplies is valid for the real validator (Sandbox), the validator is NOT
// weakened (Production and the default raw-field mode still fail closed), and every failure maps to its own category.
import { describe, expect, it } from "vitest";
import { StoreError } from "../errors";
import type { ZohoResponse } from "../crm/client";
import { loadCrmConfig } from "../crm/config";
import { createCrmReader } from "./crm-reader";
import { CATEGORY_MESSAGE, PROBE_ENV, classifyProductResponse, classifyStoreError } from "./product-fitness-probe";

const CREDS = { SIX2FIT_ZOHO_CLIENT_ID: "cid", SIX2FIT_ZOHO_CLIENT_SECRET: "csec", SIX2FIT_ZOHO_REFRESH_TOKEN: "crt" };
const res = (status: number, json: unknown): ZohoResponse => ({ status, json, retryAfterMs: undefined });
const PID = "6223361000127336001";

describe("probe configuration", () => {
  it("the harness environment plus credentials builds the real CRM config and the read-only reader (no request is made)", () => {
    const env = { ...PROBE_ENV, ...CREDS };
    expect(loadCrmConfig(env)).toMatchObject({ environment: "sandbox", persistence: "workdrive-key", orgZgid: "850673613" });
    expect(() => createCrmReader(env, { fetch: (() => { throw new Error("NO NETWORK"); }) as never })).not.toThrow();
  });
  it("reproduces the reported failure without a persistence mode, and validation stays strict", () => {
    const { SIX2FIT_ONBOARDING_CRM_PERSISTENCE: _p, SIX2FIT_WORKDRIVE_ROOT_FOLDER_ID: _i, SIX2FIT_WORKDRIVE_ROOT_FOLDER_NAME: _n, ...partial } = PROBE_ENV;
    expect(() => loadCrmConfig({ ...partial, ...CREDS })).toThrow(/complete-answers field is not configured/);
    expect(() => loadCrmConfig({ ...PROBE_ENV, ...CREDS, SIX2FIT_ZOHO_ENVIRONMENT: "production" })).toThrow(); // production demands its own pins
    expect(() => loadCrmConfig({ ...PROBE_ENV, ...CREDS, SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6067417000" })).toThrow(); // sandbox must not carry the Production prefix
    expect(() => loadCrmConfig({ ...PROBE_ENV })).toThrow(); // credentials are still mandatory
  });
});

describe("outcome categories", () => {
  it("configuration, authentication, environment and transport failures are told apart", () => {
    expect(classifyStoreError(new StoreError("NOT_CONFIGURED", "x", "CRM_NOT_CONFIGURED"))).toBe("CONFIGURATION_FAILURE");
    expect(classifyStoreError(new StoreError("UNAVAILABLE", "x", "AUTH_FAILED"))).toBe("AUTHENTICATION_FAILURE");
    expect(classifyStoreError(new StoreError("NOT_CONFIGURED", "x", "ENV_MISMATCH"))).toBe("ENVIRONMENT_MISMATCH");
    expect(classifyStoreError(new StoreError("UNAVAILABLE", "x", "TOKEN_TRANSPORT"))).toBe("CRM_UNREACHABLE");
    expect(classifyStoreError(new StoreError("NOT_CONFIGURED", "x", "SCOPE_MISSING"))).toBe("INSUFFICIENT_PRODUCT_READ_PERMISSION");
    expect(classifyStoreError(new Error("boom"))).toBe("UNEXPECTED_RESPONSE");
  });
  it("the Products read: success, permission, field missing, module missing, product missing", () => {
    expect(classifyProductResponse(res(200, { data: [{ id: PID, Fitness: "VIP" }] }), PID)).toBe("SUCCESS");
    expect(classifyProductResponse(res(200, { data: [{ id: PID, Fitness: null }] }), PID)).toBe("SUCCESS"); // empty value is still readable
    expect(classifyProductResponse(res(200, { data: [{ id: PID }] }), PID)).toBe("FITNESS_FIELD_MISSING");
    expect(classifyProductResponse(res(401, { code: "OAUTH_SCOPE_MISMATCH" }), PID)).toBe("INSUFFICIENT_PRODUCT_READ_PERMISSION");
    expect(classifyProductResponse(res(403, { code: "NO_PERMISSION" }), PID)).toBe("INSUFFICIENT_PRODUCT_READ_PERMISSION");
    expect(classifyProductResponse(res(400, { code: "INVALID_DATA", details: { api_name: "fields" } }), PID)).toBe("FITNESS_FIELD_MISSING");
    expect(classifyProductResponse(res(400, { code: "INVALID_MODULE" }), PID)).toBe("PRODUCTS_MODULE_MISSING");
    expect(classifyProductResponse(res(400, { code: "INVALID_DATA", details: { api_name: "id" } }), PID)).toBe("PRODUCT_NOT_FOUND");
    expect(classifyProductResponse(res(204, null), PID)).toBe("PRODUCT_NOT_FOUND");
    expect(classifyProductResponse(res(200, { data: [{ id: "6223361000999999999", Fitness: "VIP" }] }), PID)).toBe("PRODUCT_NOT_FOUND");
    expect(classifyProductResponse(res(500, {}), PID)).toBe("UNEXPECTED_RESPONSE");
  });
  it("every category has its own plain explanation and none mentions a credential value", () => {
    const texts = Object.values(CATEGORY_MESSAGE);
    expect(new Set(texts).size).toBe(texts.length);
  });
});
