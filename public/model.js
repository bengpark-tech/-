/* GRANDSUN 태양광 사업성 계산 모델 — 브라우저와 서버(Node)가 같은 코드를 사용합니다. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GS = api;
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

/* ---------- 입력 정의 ---------- */
const FIELDS = [
  { group: "발전 조건", items: [
    { id: "cap",   label: "설치 용량",     unit: "kW",    def: 100,     min: 1,   max: 1000000, dec: 1 },
    { id: "hours", label: "하루 발전시간", unit: "시간",  def: 3.5,     min: 0.1, max: 24,      dec: 2 },
    { id: "deg",   label: "성능저하율",    unit: "%/년",  def: 0.5,     min: 0,   max: 20,      dec: 2 }
  ]},
  { group: "판매 단가", items: [
    { id: "smp",   label: "SMP 단가",      unit: "원/kWh", def: 130,    min: 0,   max: 2000,    dec: 1 },
    { id: "rec",   label: "REC 단가",      unit: "원/kWh", def: 70,     min: 0,   max: 2000,    dec: 1, sub: "REC 1개(1MWh) 가격 ÷ 1,000" }
  ]},
  { group: "투자·운영", items: [
    { id: "unit",  label: "설치 단가",     unit: "원/kW",  def: 1500000, min: 1,  max: 100000000, dec: 0, hint: "cost" },
    { id: "opex",  label: "운영비",        unit: "%/년",   def: 1.5,    min: 0,   max: 50,      dec: 2, sub: "총사업비 대비 연 비율", hint: "opex" },
    { id: "years", label: "분석 기간",     unit: "년",     def: 20,     min: 1,   max: 40,      dec: 0, int: true }
  ]},
  { group: "금융·할인", items: [
    { id: "equity", label: "자기자본 비율", unit: "%",     def: 30,     min: 0,   max: 100,     dec: 1, hint: "fund" },
    { id: "rate",   label: "대출 금리",     unit: "%/년",  def: 5,      min: 0,   max: 30,      dec: 2 },
    { id: "term",   label: "대출 기간",     unit: "년",    def: 10,     min: 1,   max: 40,      dec: 0, int: true },
    { id: "disc",   label: "할인율",        unit: "%",     def: 5,      min: 0,   max: 30,      dec: 2, sub: "NPV·LCOE 계산용" }
  ]}
];
const ALL = FIELDS.flatMap(g => g.items);

/* 계절 보정계수(1~12월, 일평균 발전량의 상대값) — 연 합계가 입력값과 같도록 정규화 */
const MONTH_DAYS = [31,28,31,30,31,30,31,31,30,31,30,31];
const SEASON = [0.70,0.85,1.05,1.15,1.20,1.10,0.90,1.00,1.00,1.00,0.80,0.65];
const SEASON_K = 365 / SEASON.reduce((s, f, i) => s + f * MONTH_DAYS[i], 0);

/* 환경 환산 계수 */
const CO2_KG_PER_KWH = 0.4594;   // 전력 배출계수
const TREE_KG_PER_YEAR = 6.6;    // 소나무 1그루 연간 CO2 흡수량
const CAR_T_PER_YEAR = 2.4;      // 승용차 1대 연간 CO2 배출량

/* ---------- 금융 계산 ---------- */
function irr(cfs) {
  const f = r => cfs.reduce((s, c, t) => s + c / Math.pow(1 + r, t), 0);
  let lo = -0.99, hi = 10, flo = f(lo), fhi = f(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}
const npv = (cfs, r) => cfs.reduce((s, c, t) => s + c / Math.pow(1 + r, t), 0);
/* 누적이 음수 → 0 이상으로 넘어서는 첫 시점(선형 보간) */
function payback(cum) {
  for (let t = 1; t < cum.length; t++) {
    if (cum[t - 1] < 0 && cum[t] >= 0) return t - 1 + (-cum[t - 1]) / (cum[t] - cum[t - 1]);
  }
  return null;
}

/* ---------- 시뮬레이션 ---------- */
function simulate(p) {
  const N = p.years;
  const cost = p.cap * p.unit;
  const eq = cost * p.equity / 100;
  const loan = cost - eq;
  const price = p.smp + p.rec;
  const r = p.rate / 100;
  const n = Math.min(p.term, 40);
  const pmt = loan > 0 ? (r > 0 ? loan * r / (1 - Math.pow(1 + r, -n)) : loan / n) : 0;
  const opex = cost * p.opex / 100;
  const dailyBase = p.cap * p.hours;

  const rows = [];
  let bal = loan, cum = -eq, cumP = -cost;
  const eqCF = [-eq], prCF = [-cost], cumEq = [-eq], cumPr = [-cost];
  for (let t = 1; t <= N; t++) {
    const gen = dailyBase * 365 * Math.pow(1 - p.deg / 100, t - 1);
    const rev = gen * price;
    const interest = bal * r;
    let pay = 0, principal = 0;
    if (t <= n && loan > 0) { pay = pmt; principal = pmt - interest; bal -= principal; }
    if (t === N && bal > 1) { pay += bal; principal += bal; bal = 0; }
    const net = rev - opex - pay;
    cum += net; cumP += rev - opex;
    rows.push({ t, gen, rev, opex, pay, interest, principal, net, cum, proj: rev - opex, cumP });
    eqCF.push(net); prCF.push(rev - opex); cumEq.push(cum); cumPr.push(cumP);
  }

  /* LCOE = (총사업비 + 운영비 현가) / 발전량 현가 */
  const d = p.disc / 100;
  let pvCost = cost, pvGen = 0;
  rows.forEach(x => { const k = Math.pow(1 + d, x.t); pvCost += x.opex / k; pvGen += x.gen / k; });
  const lcoe = pvGen > 0 ? pvCost / pvGen : null;

  /* 월별(1년차) */
  const monthly = MONTH_DAYS.map((days, i) => {
    const gen = dailyBase * days * SEASON[i] * SEASON_K;
    return { m: i + 1, days, gen, rev: gen * price, daily: gen / days };
  });

  /* 환경 */
  let cumCO2 = 0;
  const co2 = rows.map(x => { const kg = x.gen * CO2_KG_PER_KWH; cumCO2 += kg; return { t: x.t, kg, cum: cumCO2 }; });

  return {
    p, N, cost, eq, loan, price, pmt, opex, rows, monthly, co2, lcoe,
    eqCF, prCF, cumEq, cumPr,
    irrEq: irr(eqCF), irrPr: irr(prCF),
    npvEq: npv(eqCF, d), npvPr: npv(prCF, d),
    pbEq: payback(cumEq), pbPr: payback(cumPr),
    totalNet: cumEq[N], totalRev: rows.reduce((s, x) => s + x.rev, 0),
    totalGen: rows.reduce((s, x) => s + x.gen, 0),
    loanOver: p.term > N && loan > 0
  };
}

/* 입력값 검증: 숫자가 아니면 기본값, 범위를 벗어나면 보정 */
function sanitizeInputs(inp) {
  const o = {};
  ALL.forEach(f => {
    let v = Number(inp && inp[f.id]);
    if (!isFinite(v)) v = f.def;
    v = Math.min(f.max, Math.max(f.min, v));
    o[f.id] = f.int ? Math.round(v) : v;
  });
  return o;
}

/* 이력에 저장하는 핵심 결과 */
const summarize = m => ({
  cost: m.cost, rev1: m.rows[0].rev, pbPr: m.pbPr, pbEq: m.pbEq, irrEq: m.irrEq, irrPr: m.irrPr,
  npvEq: m.npvEq, npvPr: m.npvPr, lcoe: m.lcoe, totalNet: m.totalNet
});

return { FIELDS, ALL, MONTH_DAYS, SEASON, SEASON_K, CO2_KG_PER_KWH, TREE_KG_PER_YEAR, CAR_T_PER_YEAR, irr, npv, payback, simulate, sanitizeInputs, summarize };
});
