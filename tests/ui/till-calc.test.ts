import { describe, expect, it } from "vitest";
import { calcDisplay, calcPress, initialCalc } from "@/app/retail/sell/_lib/calc";

const run = (keys: string) => calcDisplay([...keys].reduce((s, k) => calcPress(s, k), initialCalc));

describe("till calculator", () => {
  it("adds and chains", () => {
    expect(run("7+5=")).toBe("12");
    expect(run("2+3+4=")).toBe("9");
  });
  it("never throws on division by zero", () => {
    expect(run("10/0=")).toBe("0");
  });
  it("percent: of the accumulator after + and -, hundredths otherwise", () => {
    expect(run("200+10%=")).toBe("220");
    expect(run("5*3%=")).toBe("0.15");
  });
  it("clear, backspace, one decimal point, rounding", () => {
    expect(run("12C")).toBe("0");
    expect(run("7B")).toBe("0");
    expect(run("1.2.3")).toBe("1.23");
    expect(run("1/3=")).toBe("0.333333");
  });
});
