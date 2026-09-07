import { describe, expect, it } from "vitest";
import { GATEWAYS, gatewayUrl, isCidV1, resolveGateway } from "./gateways";

const CID = "bafybeibbtppbjuszuht4z5roonjyyszestlkhgwuups6g76iempza3lkni";

describe("gateways", () => {
  it("derives /ipfs/<cid> URLs and encodes sub paths", () => {
    expect(gatewayUrl(GATEWAYS[0]!, CID)).toBe(`https://ipfs.io/ipfs/${CID}`);
    expect(gatewayUrl("https://dweb.link/", CID, "query-tables/properties.parquet")).toBe(
      `https://dweb.link/ipfs/${CID}/query-tables/properties.parquet`,
    );
    expect(gatewayUrl("https://dweb.link", CID, "a b/c")).toBe(
      `https://dweb.link/ipfs/${CID}/a%20b/c`,
    );
  });
  it("lists four independent public gateways plus the vendor gateway", () => {
    expect(GATEWAYS.filter((g) => g.independent).map((g) => g.key)).toEqual([
      "ipfs.io",
      "dweb.link",
      "pinata",
      "w3s.link",
    ]);
    expect(GATEWAYS.find((g) => g.key === "filebase")?.independent).toBe(false);
  });
  it("only resolves whitelisted gateways", () => {
    expect(resolveGateway("ipfs.io")?.origin).toBe("https://ipfs.io");
    expect(resolveGateway("https://dweb.link/")?.key).toBe("dweb.link");
    expect(resolveGateway("https://evil.example")).toBeNull();
  });
  it("validates CIDv1 base32", () => {
    expect(isCidV1(CID)).toBe(true);
    expect(isCidV1("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(false);
    expect(isCidV1("../etc/passwd")).toBe(false);
  });
});
