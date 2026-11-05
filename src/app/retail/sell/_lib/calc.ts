/* The till's calculator, pure. Keys: 0-9 . + - * / % = C (clear) B (backspace). */

export type CalcState = { acc: number | null; op: "+" | "-" | "*" | "/" | null; cur: string; fresh: boolean };
export const initialCalc: CalcState = { acc: null, op: null, cur: "0", fresh: false };

const round = (n: number) => Number.isFinite(n) ? +n.toFixed(6) : 0;
const apply = (a: number, op: NonNullable<CalcState["op"]>, b: number) =>
  op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : b === 0 ? 0 : a / b;

export function calcPress(s: CalcState, key: string): CalcState {
  const v = parseFloat(s.cur) || 0;
  if (/^\d$/.test(key)) return { ...s, cur: s.fresh || s.cur === "0" ? key : s.cur + key, fresh: false };
  if (key === ".") {
    const base = s.fresh ? "0" : s.cur;
    return { ...s, cur: base.includes(".") ? base : base + ".", fresh: false };
  }
  if (key === "C") return initialCalc;
  if (key === "B") return { ...s, cur: s.cur.length > 1 ? s.cur.slice(0, -1) : "0" };
  if (key === "%") {
    const pct = s.op && s.acc !== null && (s.op === "+" || s.op === "-") ? (s.acc * v) / 100 : v / 100;
    return { ...s, cur: String(round(pct)), fresh: false };
  }
  if (key === "=") {
    if (!s.op || s.acc === null) return s;
    return { acc: null, op: null, cur: String(round(apply(s.acc, s.op, v))), fresh: true };
  }
  if (key === "+" || key === "-" || key === "*" || key === "/") {
    const acc = s.op && s.acc !== null && !s.fresh ? round(apply(s.acc, s.op, v)) : v;
    return { acc, op: key, cur: String(acc), fresh: true };
  }
  return s;
}

/** ASCII text of the current value; the view formats it for the locale. */
export const calcDisplay = (s: CalcState) => s.cur;
