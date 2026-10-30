import { describe, expect, it } from "vitest";
import {
  INTAKE_MAX_BYTES,
  INTAKE_MAX_IMAGES,
  INTAKE_MAX_LINES,
  barcodeCheck,
  checkLineArithmetic,
  checkReceiptTotal,
  classifyLine,
  intakeFileHash,
  isValidBarcodeChecksum,
  matchUnitText,
  normalizeDigits,
} from "@/server/domain/intake";

function ean13(body12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3);
  return body12 + String((10 - (sum % 10)) % 10);
}

const units = [
  { id: "u1", name: "كرتون" },
  { id: "u2", name: "قطعة" },
];

describe("intake limits", () => {
  it("exposes the constants", () => {
    expect(INTAKE_MAX_IMAGES).toBe(6);
    expect(INTAKE_MAX_LINES).toBe(100);
    expect(INTAKE_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("normalizeDigits", () => {
  it("converts Arabic-Indic and Persian digits and separators", () => {
    expect(normalizeDigits("٣٫٥")).toBe("3.5");
    expect(normalizeDigits("۱٬۲۳۴")).toBe("1,234");
    expect(normalizeDigits("abc 12")).toBe("abc 12");
  });
});

describe("barcode checksum", () => {
  it("accepts a valid EAN-13 and rejects a wrong check digit", () => {
    const good = ean13("622103101111");
    expect(isValidBarcodeChecksum(good)).toBe(true);
    const bad = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
    expect(isValidBarcodeChecksum(bad)).toBe(false);
    expect(barcodeCheck(bad)).toEqual({ ok: false, checked: true });
    expect(barcodeCheck(good)).toEqual({ ok: true, checked: true });
  });
  it("checks EAN-8 and UPC-A", () => {
    expect(barcodeCheck("73513537")).toEqual({ ok: true, checked: true });
    expect(barcodeCheck("73513538")).toEqual({ ok: false, checked: true });
    expect(barcodeCheck("036000291452")).toEqual({ ok: true, checked: true });
    expect(barcodeCheck("036000291453")).toEqual({ ok: false, checked: true });
  });
  it("normalizes Arabic-Indic digits first", () => {
    expect(barcodeCheck("٧٣٥١٣٥٣٧")).toEqual({ ok: true, checked: true });
  });
  it("passes other lengths unchecked", () => {
    expect(barcodeCheck("12345")).toEqual({ ok: true, checked: false });
    expect(barcodeCheck("ABC-123")).toEqual({ ok: true, checked: false });
    for (const c of ["ABCD1234", "ABCDEFGH1234", "ABCDEFGHIJ123"]) {
      expect(barcodeCheck(c)).toEqual({ ok: true, checked: false });
    }
    expect(isValidBarcodeChecksum("12345")).toBe(false);
  });
});

describe("matchUnitText", () => {
  it("matches by name", () => {
    expect(matchUnitText("كرتون", units)).toBe("u1");
    expect(matchUnitText("قطعة", units)).toBe("u2");
  });
  it("returns null when the unit is absent", () => {
    expect(matchUnitText("دزينة", units)).toBeNull();
  });
  it("matches synonyms and aliases", () => {
    expect(matchUnitText("Carton", units)).toBe("u1");
    expect(matchUnitText("pcs", units)).toBe("u2");
    expect(matchUnitText("dozen", [...units, { id: "u3", name: "دزينة" }])).toBe("u3");
    expect(matchUnitText("box", [{ id: "x", name: "pack", aliases: ["box"] }])).toBe("x");
  });
  it("returns null when ambiguous or empty", () => {
    const dup = [
      { id: "a", name: "كرتون" },
      { id: "b", name: "كارتون" },
    ];
    expect(matchUnitText("carton", dup)).toBeNull();
    expect(matchUnitText("  ", units)).toBeNull();
  });
  it("matches Kurdish synonyms", () => {
    expect(matchUnitText("كارتۆن", units)).toBe("u1");
    expect(matchUnitText("دانە", units)).toBe("u2");
    expect(matchUnitText("دوزینە", [...units, { id: "u3", name: "dozen" }])).toBe("u3");
  });
});

describe("checkLineArithmetic", () => {
  it("IQD: 3 x 1500 = 4500", () => {
    expect(checkLineArithmetic({ quantity: "3", unitPrice: "1500", lineTotal: "4500" }, "IQD")).toEqual({ ok: true });
    expect(checkLineArithmetic({ quantity: "3", unitPrice: "1500", lineTotal: "4600" }, "IQD")).toEqual({
      ok: false,
      reason: "TOTAL_MISMATCH",
    });
  });
  it("IQD tolerates one dinar, no more", () => {
    expect(checkLineArithmetic({ quantity: "3", unitPrice: "1500", lineTotal: "4501" }, "IQD").ok).toBe(true);
    expect(checkLineArithmetic({ quantity: "3", unitPrice: "1500", lineTotal: "4502" }, "IQD").ok).toBe(false);
  });
  it("reads Arabic digits and decimal quantities", () => {
    expect(checkLineArithmetic({ quantity: "٢٫٥", unitPrice: "١٬٠٠٠", lineTotal: "٢٥٠٠" }, "IQD").ok).toBe(true);
  });
  it("USD tolerates half a cent", () => {
    expect(checkLineArithmetic({ quantity: "3", unitPrice: "1.10", lineTotal: "3.30" }, "USD").ok).toBe(true);
    expect(checkLineArithmetic({ quantity: "3", unitPrice: "1.10", lineTotal: "3.31" }, "USD").ok).toBe(false);
    expect(checkLineArithmetic({ quantity: "0.5", unitPrice: "0.01", lineTotal: "0.01" }, "USD").ok).toBe(true);
  });
  it("is ok without a line total when quantity and price are readable", () => {
    expect(checkLineArithmetic({ quantity: "3", unitPrice: "1500" }, "IQD")).toEqual({ ok: true });
  });
  it("flags unreadable input as UNREADABLE, even without a line total", () => {
    const bad = { ok: false, reason: "UNREADABLE" };
    expect(checkLineArithmetic({ quantity: "x", unitPrice: "1500", lineTotal: "1" }, "IQD")).toEqual(bad);
    expect(checkLineArithmetic({ quantity: "x", unitPrice: "1500" }, "IQD")).toEqual(bad);
    expect(checkLineArithmetic({ quantity: "0", unitPrice: "1500" }, "IQD")).toEqual(bad);
    expect(checkLineArithmetic({ quantity: "-2", unitPrice: "1500" }, "IQD")).toEqual(bad);
    expect(checkLineArithmetic({ quantity: "2", unitPrice: "-1500" }, "IQD")).toEqual(bad);
    expect(checkLineArithmetic({ quantity: "2", unitPrice: "1500", lineTotal: "abc" }, "IQD")).toEqual(bad);
  });
  it("treats a decimal comma as unreadable, never 25", () => {
    const bad = { ok: false, reason: "UNREADABLE" };
    expect(checkLineArithmetic({ quantity: "2,5", unitPrice: "100", lineTotal: "2500" }, "IQD")).toEqual(bad);
    expect(checkLineArithmetic({ quantity: "1,5", unitPrice: "100" }, "IQD")).toEqual(bad);
    expect(checkLineArithmetic({ quantity: "1,000", unitPrice: "2", lineTotal: "2000" }, "IQD").ok).toBe(true);
  });
  it("rejects huge strings", () => {
    expect(checkLineArithmetic({ quantity: "1".repeat(40), unitPrice: "1" }, "IQD").reason).toBe("UNREADABLE");
  });
  it("IQD price with a fraction like 1.500 is unreadable", () => {
    expect(checkLineArithmetic({ quantity: "1", unitPrice: "1.500" }, "IQD").reason).toBe("UNREADABLE");
  });
});

describe("checkReceiptTotal", () => {
  const lines = [
    { quantity: "3", unitPrice: "1500", lineTotal: "4500" },
    { quantity: "2", unitPrice: "250" },
  ];
  it("compares the sum to the receipt total", () => {
    expect(checkReceiptTotal(lines, "5000", "IQD")).toEqual({ ok: true });
    expect(checkReceiptTotal(lines, "5100", "IQD")).toEqual({ ok: false });
  });
  it("tolerance boundary: one dinar per line", () => {
    expect(checkReceiptTotal(lines, "5002", "IQD").ok).toBe(true);
    expect(checkReceiptTotal(lines, "4998", "IQD").ok).toBe(true);
    expect(checkReceiptTotal(lines, "5003", "IQD").ok).toBe(false);
  });
  it("is ok when no total was read", () => {
    expect(checkReceiptTotal(lines, undefined, "IQD")).toEqual({ ok: true });
  });
});

describe("classifyLine", () => {
  const base = { unitMatched: true, arithmeticOk: true, confidence: 0.9 };
  it("MATCHED only for exact barcode with unit and arithmetic ok", () => {
    expect(classifyLine({ ...base, match: "barcode-exact" })).toBe("MATCHED");
  });
  it("SUGGESTED for a name match", () => {
    expect(classifyLine({ ...base, match: "name-suggested" })).toBe("SUGGESTED");
  });
  it("UNKNOWN when nothing matched", () => {
    expect(classifyLine({ ...base, match: "none" })).toBe("UNKNOWN");
  });
  it("DOUBTFUL wins over matches", () => {
    expect(classifyLine({ ...base, match: "barcode-exact", unitMatched: false })).toBe("DOUBTFUL");
    expect(classifyLine({ ...base, match: "barcode-exact", arithmeticOk: false })).toBe("DOUBTFUL");
    expect(classifyLine({ ...base, match: "name-suggested", confidence: 0.59 })).toBe("DOUBTFUL");
    expect(classifyLine({ ...base, match: "barcode-exact", confidence: 0.6 })).toBe("MATCHED");
  });
});

describe("intakeFileHash", () => {
  it("is a stable sha256 hex of the ordered concatenation", () => {
    const h = intakeFileHash([Buffer.from("ab"), Buffer.from("c")]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(intakeFileHash([Buffer.from("ab"), Buffer.from("c")]));
    expect(h).not.toBe(intakeFileHash([Buffer.from("c"), Buffer.from("ab")]));
  });
  it("does not collide across part boundaries", () => {
    expect(intakeFileHash([Buffer.from("A"), Buffer.from("BC")])).not.toBe(
      intakeFileHash([Buffer.from("AB"), Buffer.from("C")]),
    );
  });
});
