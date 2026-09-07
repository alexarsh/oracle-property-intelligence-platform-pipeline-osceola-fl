import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENTRUST_OV_TLS_ISSUING_RSA_CA_2_PEM } from "./certs/index.js";

describe("pinned intermediate certificate", () => {
  it("matches the .pem file byte for byte", () => {
    const pem = readFileSync(new URL("./certs/entrust-ov-tls-issuing-rsa-ca-2.pem", import.meta.url), "utf8");
    expect(ENTRUST_OV_TLS_ISSUING_RSA_CA_2_PEM).toBe(pem);
  });
  it("is the Entrust OV TLS Issuing RSA CA 2 intermediate", () => {
    const cert = new X509Certificate(ENTRUST_OV_TLS_ISSUING_RSA_CA_2_PEM);
    expect(cert.subject).toContain("CN=Entrust OV TLS Issuing RSA CA 2");
    expect(cert.ca).toBe(true);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});
