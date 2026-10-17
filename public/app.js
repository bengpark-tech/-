"use strict";
/* =====================================================================
   GRANDSUN 태양광 종합 사업성 시뮬레이터
   ===================================================================== */

const { FIELDS, ALL, CO2_KG_PER_KWH, TREE_KG_PER_YEAR, CAR_T_PER_YEAR, simulate, sanitizeInputs } = GS;


/* ---------- 포맷 ---------- */
const fmt = (n, d = 0) => Number(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });

/* 원 → "1억 5,000만원" */
function won(n) {
  if (!isFinite(n)) return "-";
  const neg = n < 0;
  const m = Math.round(Math.abs(n) / 10000);
  if (m === 0) return "0원";
  const eok = Math.floor(m / 10000), man = m % 10000;
  let s = "";
  if (eok) s += fmt(eok) + "억";
  if (man) s += (eok ? " " : "") + fmt(man) + "만";
  return (neg ? "-" : "") + s + "원";
}
/* 만원 단위 정수 (표용) */
const man = n => fmt(Math.round(n / 10000));
/* 축 라벨용 축약 */
function shortNum(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return fmt(+(v / 1e8).toFixed(2), 2).replace(/\.?0+$/, "") + "억";
  if (a >= 1e4) return fmt(+(v / 1e4).toFixed(1), 1).replace(/\.?0+$/, "") + "만";
  return fmt(v);
}
const pct = (r, d = 1) => (r === null || !isFinite(r)) ? "—" : fmt(r * 100, d) + "%";
function yearsText(y) {
  let yr = Math.floor(y), mo = Math.round((y - yr) * 12);
  if (mo === 12) { yr++; mo = 0; }
  return (yr ? yr + "년 " : "") + (mo ? mo + "개월" : (yr ? "" : "0개월"));
}
function textW(s) {
  let w = 0;
  for (const ch of String(s)) w += ch > "ÿ" ? 11 : 6.3;
  return w;
}


/* ---------- 입력 폼 ---------- */
const P = {};
const panelBody = document.getElementById("panelBody");
let M = null;

function buildForm() {
  let html = userGroupHTML();
  FIELDS.forEach(g => {
    html += `<div class="group"><h3>${g.group}</h3>`;
    g.items.forEach(f => {
      html += `<div class="field">
        <label for="in-${f.id}">${f.label}${f.sub ? `<span class="sub">${f.sub}</span>` : ""}</label>
        <div class="inp" id="w-${f.id}"><input id="in-${f.id}" type="text" inputmode="decimal" autocomplete="off" value="${fmt(f.def, f.dec)}"><span>${f.unit}</span></div>
        ${f.hint ? `<div class="hint" id="h-${f.hint}"></div>` : ""}
      </div>`;
    });
    html += `</div>`;
  });
  html += `<div class="group"><button type="button" class="btn primary wide" id="reportBtn2">보고서 생성</button>
    <p class="note">보고서를 생성하면 사용자 정보와 현재 입력 조건이 이력관리에 저장됩니다.</p></div>`;
  panelBody.innerHTML = html;
  ALL.forEach(f => {
    const el = document.getElementById("in-" + f.id);
    P[f.id] = f.def;
    el.addEventListener("input", update);
    el.addEventListener("blur", () => { el.value = fmt(P[f.id], f.dec); document.getElementById("w-" + f.id).classList.remove("invalid"); });
    el.addEventListener("focus", () => el.select());
  });
}

function parseNum(s) {
  const t = String(s).replace(/[,\s원]/g, "");
  if (t === "" || t === "-" || t === ".") return NaN;
  return Number(t);
}
function readInputs() {
  ALL.forEach(f => {
    const el = document.getElementById("in-" + f.id);
    let v = parseNum(el.value);
    const wrap = document.getElementById("w-" + f.id);
    if (!isFinite(v)) { wrap.classList.add("invalid"); return; }   // 입력 중이면 직전 값 유지
    let bad = v < f.min || v > f.max;
    v = Math.min(f.max, Math.max(f.min, v));
    if (f.int) v = Math.round(v);
    P[f.id] = v;
    wrap.classList.toggle("invalid", bad);
  });
}
function resetAll() {
  ALL.forEach(f => {
    P[f.id] = f.def;
    document.getElementById("in-" + f.id).value = fmt(f.def, f.dec);
    document.getElementById("w-" + f.id).classList.remove("invalid");
  });
  update();
}

function updateHints() {
  const set = (k, t) => { const e = document.getElementById("h-" + k); if (e) e.textContent = t; };
  set("cost", `총사업비 ${won(M.cost)}  (${fmt(P.cap)}kW × ${won(P.unit)})`);
  set("opex", `연 운영비 ${won(M.opex)}`);
  set("fund", `자기자본 ${won(M.eq)} · 대출 ${won(M.loan)}` + (M.loan > 0 ? ` · 연 원리금 ${won(M.pmt)}` : ""));
  document.getElementById("panelSum").textContent =
    `${fmt(P.cap)}kW · 총사업비 ${won(M.cost)} · ${P.years}년`;
}

/* ---------- 차트 공통 ---------- */
function niceTicks(min, max, n) {
  if (!(max > min)) max = min + (Math.abs(min) || 1);
  const raw = (max - min) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), nr = raw / mag;
  const step = (nr <= 1 ? 1 : nr <= 2 ? 2 : nr <= 5 ? 5 : 10) * mag;
  const a = Math.floor(min / step + 1e-9), b = Math.ceil(max / step - 1e-9), t = [];
  for (let i = a; i <= b; i++) t.push(+(i * step).toPrecision(12));
  return t;
}
const chartH = w => (w < 480 ? 240 : 300);

function lineChart(o) {
  const { w, h } = o;
  const vals = o.series.flatMap(s => s.values);
  const lo = Math.min(...vals, o.includeZero ? 0 : Infinity);
  const hi = Math.max(...vals, o.includeZero ? 0 : -Infinity);
  const ticks = niceTicks(lo, hi, 5);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const m = { r: 16, t: 14, b: 34 };
  m.l = Math.max(...ticks.map(v => textW(o.yFmt(v)))) + 16;
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const xs = o.xs, xa = xs[0], xb = xs[xs.length - 1] === xs[0] ? xs[0] + 1 : xs[xs.length - 1];
  const X = v => m.l + (v - xa) / (xb - xa) * pw;
  const Y = v => m.t + (1 - (v - y0) / (y1 - y0)) * ph;
  let s = "";
  ticks.forEach(v => {
    s += `<line class="gl" x1="${m.l}" x2="${w - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
    s += `<text class="ax" x="${m.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${o.yFmt(v)}</text>`;
  });
  const step = Math.ceil(xs.length / Math.max(2, Math.floor(pw / 40)));
  xs.forEach((x, i) => {
    if (i % step) return;
    s += `<text class="ax" x="${X(x).toFixed(1)}" y="${h - 16}" text-anchor="middle">${x}</text>`;
  });
  s += `<text class="ax" x="${w - m.r}" y="${h - 2}" text-anchor="end">${o.xTitle || ""}</text>`;

  /* 0선 */
  let zeroY = null;
  if (o.zero && y0 < 0 && y1 > 0) {
    zeroY = Y(0);
    s += `<line x1="${m.l}" x2="${w - m.r}" y1="${zeroY}" y2="${zeroY}" stroke="var(--orange)" stroke-width="2" stroke-dasharray="6 4"/>`;
    s += `<text x="${w - m.r - 2}" y="${zeroY + 15}" text-anchor="end" font-size="11.5" font-weight="700" fill="var(--orange)">${o.zero}</text>`;
  }
  /* 선·면·점 */
  o.series.forEach(se => {
    const d = se.values.map((v, i) => (i ? "L" : "M") + X(xs[i]).toFixed(1) + " " + Y(v).toFixed(1)).join("");
    if (se.area) {
      const base = Y(Math.max(y0, Math.min(y1, 0)));
      s += `<path d="${d}L${X(xs[xs.length - 1]).toFixed(1)} ${base}L${X(xs[0]).toFixed(1)} ${base}Z" fill="${se.color}" opacity=".12"/>`;
    }
    s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2.5}" stroke-linejoin="round" stroke-linecap="round"${se.dash ? ` stroke-dasharray="${se.dash}"` : ""}/>`;
    if (xs.length <= 26 && pw / xs.length >= 15 && !se.noPts) {
      se.values.forEach((v, i) => {
        const c = se.ptColor ? se.ptColor(v) : se.color;
        s += `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3.2" fill="#fff" stroke="${c}" stroke-width="2"/>`;
      });
    }
  });
  /* 회수 시점 표시 */
  if (o.mark != null && zeroY !== null) {
    const mx = X(o.mark), label = o.markLabel, tw = textW(label) + 14;
    let rx = mx - 10 - tw; if (rx < m.l + 2) rx = mx + 12;
    s += `<line x1="${mx}" x2="${mx}" y1="${zeroY}" y2="${m.t}" stroke="var(--orange)" stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>`;
    s += `<rect x="${rx.toFixed(1)}" y="${zeroY - 30}" width="${tw}" height="21" rx="10.5" fill="var(--orange)"/>`;
    s += `<text x="${(rx + tw / 2).toFixed(1)}" y="${zeroY - 15.5}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${label}</text>`;
    s += `<circle cx="${mx}" cy="${zeroY}" r="6.5" fill="#fff" stroke="var(--orange)" stroke-width="3.5"/>`;
  }
  s += `<line class="guide" y1="${m.t}" y2="${h - m.b}" stroke="var(--navy)" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`;
  return {
    svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${o.aria}">${s}</svg>`,
    px: xs.map(X), tips: xs.map((_, i) => o.tips(i)), w
  };
}

function barChart(o) {
  const { w, h } = o;
  const ticks = niceTicks(0, Math.max(...o.values), 5);
  const y1 = ticks[ticks.length - 1];
  const m = { r: 8, t: 20, b: 28 };
  m.l = Math.max(...ticks.map(v => textW(o.yFmt(v)))) + 16;
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const n = o.values.length, slot = pw / n, bw = Math.min(slot * 0.64, 42);
  const Y = v => m.t + (1 - v / y1) * ph;
  let s = "";
  ticks.forEach(v => {
    s += `<line class="gl" x1="${m.l}" x2="${w - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
    s += `<text class="ax" x="${m.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${o.yFmt(v)}</text>`;
  });
  const maxI = o.values.indexOf(Math.max(...o.values));
  const px = [];
  o.values.forEach((v, i) => {
    const cx = m.l + slot * i + slot / 2, x = cx - bw / 2, y = Y(v);
    px.push(cx);
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - m.b - y).toFixed(1)}" rx="3" fill="${i === maxI ? "var(--orange)" : "var(--navy2)"}"/>`;
    s += `<text class="ax" x="${cx.toFixed(1)}" y="${h - 10}" text-anchor="middle">${slot < 34 ? o.labels[i].replace("월", "") : o.labels[i]}</text>`;
    if (slot >= 46) s += `<text x="${cx.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="var(--text)">${fmt(v)}</text>`;
  });
  s += `<line class="guide" y1="${m.t}" y2="${h - m.b}" stroke="var(--navy)" stroke-width="1" stroke-dasharray="3 3" visibility="hidden" opacity=".5"/>`;
  return {
    svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${o.aria}">${s}</svg>`,
    px, tips: o.values.map((_, i) => o.tips(i)), w
  };
}

/* 차트 삽입 + 툴팁(마우스·터치 공통) */
function mount(id, build) {
  const el = document.getElementById(id);
  const w = Math.floor(el.clientWidth);
  if (w < 40) return;
  const c = build(w, chartH(w));
  el.innerHTML = c.svg + '<div class="tip" hidden></div>';
  const svg = el.querySelector("svg"), tip = el.querySelector(".tip"), guide = svg.querySelector(".guide");
  const show = ev => {
    const x = ev.clientX - svg.getBoundingClientRect().left;
    let bi = 0, bd = Infinity;
    c.px.forEach((p, i) => { const d = Math.abs(p - x); if (d < bd) { bd = d; bi = i; } });
    guide.setAttribute("x1", c.px[bi]); guide.setAttribute("x2", c.px[bi]); guide.setAttribute("visibility", "visible");
    tip.innerHTML = c.tips[bi]; tip.hidden = false;
    tip.style.left = Math.max(0, Math.min(c.px[bi] + 12, c.w - tip.offsetWidth)) + "px";
  };
  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerdown", show);
  svg.addEventListener("pointerleave", ev => {
    if (ev.pointerType === "mouse") { tip.hidden = true; guide.setAttribute("visibility", "hidden"); }
  });
}

/* ---------- 탭별 렌더 ---------- */
function kpi(label, value, sub, cls = "", vcls = "") {
  return `<div class="kpi ${cls}"><div class="k-l">${label}</div><div class="k-v ${vcls}">${value}</div><div class="k-s">${sub}</div></div>`;
}

function kpiHTML(M) {
  const P = M.p, r1 = M.rows[0], N = M.N;
  const pbText = (pb, cum0) => pb !== null ? fmt(pb, 1) + "<small>년</small>" : (cum0 >= 0 ? "해당 없음" : "미회수");
  const pbSub = (pb, cum0, base) => pb !== null ? `약 ${yearsText(pb)} · ${base}` : (cum0 >= 0 ? "투자금이 없습니다" : `${N}년 내 회수되지 않습니다 · ${base}`);
  const cmp = M.lcoe !== null ? (M.lcoe / M.price - 1) : null;
  return kpi("총사업비", won(M.cost), `설치 단가 ${won(P.unit)}/kW × ${fmt(P.cap)}kW`, "main") +
    kpi("1년차 매출", won(r1.rev), `연 발전량 ${fmt(r1.gen)} kWh · 운영비 차감 후 ${won(r1.proj)}`, "acc") +
    kpi("단순 회수기간", pbText(M.pbPr, M.cumPr[0]), pbSub(M.pbPr, M.cumPr[0], "총사업비 기준(대출 제외)")) +
    kpi("자기자본 회수기간", pbText(M.pbEq, M.cumEq[0]), pbSub(M.pbEq, M.cumEq[0], "원리금 상환 후 기준"), "acc") +
    kpi("수익률 (IRR)", pct(M.irrEq), `자기자본 기준 · 프로젝트(총사업비) IRR ${pct(M.irrPr)}`, "", M.irrEq === null ? "" : (M.irrEq >= P.disc / 100 ? "good" : "bad")) +
    kpi("순현재가치 (NPV)", won(M.npvEq), `자기자본 기준, 할인율 ${fmt(P.disc, 1)}% · 프로젝트 NPV ${won(M.npvPr)}`, "acc", M.npvEq >= 0 ? "good" : "bad") +
    kpi("균등화발전원가 (LCOE)", M.lcoe === null ? "—" : fmt(M.lcoe, 1) + "<small>원/kWh</small>",
        cmp === null ? "" : `판매단가 ${fmt(M.price, 1)}원/kWh보다 ${fmt(Math.abs(cmp) * 100, 0)}% ${cmp <= 0 ? "낮음" : "높음"}`, "", cmp !== null && cmp > 0 ? "bad" : "good") +
    kpi(`${N}년 총 순이익`, won(M.totalNet), `누적 순현금흐름 − 자기자본 · 총 매출 ${won(M.totalRev)}`, "acc", M.totalNet >= 0 ? "" : "bad");
}

function renderSummary() {
  const N = M.N;
  document.getElementById("kpis").innerHTML = kpiHTML(M);

  /* 자금 구성 */
  const eqP = P.equity, lnP = 100 - P.equity;
  document.getElementById("fund").innerHTML =
    (eqP > 0 ? `<div class="eq" style="width:${eqP}%">자기자본 ${fmt(eqP, 0)}%</div>` : "") +
    (lnP > 0 ? `<div class="ln" style="width:${lnP}%">대출 ${fmt(lnP, 0)}%</div>` : "");
  document.getElementById("fundInfo").innerHTML =
    `<span>자기자본 <b>${won(M.eq)}</b></span><span>대출금 <b>${won(M.loan)}</b></span>` +
    (M.loan > 0 ? `<span>연 원리금 <b>${won(M.pmt)}</b></span><span>총 이자 <b>${won(M.rows.reduce((s, x) => s + x.interest, 0))}</b></span>` : "");

  /* 진단 */
  const notes = [];
  const neg = M.rows.filter(x => x.net < 0);
  if (M.pbEq !== null && M.pbEq <= N * 0.5) notes.push(["ok", `자기자본은 약 ${yearsText(M.pbEq)} 만에 회수되어 분석기간(${N}년)의 절반 이내입니다.`]);
  else if (M.pbEq !== null) notes.push(["", `자기자본 회수까지 약 ${yearsText(M.pbEq)}가 걸립니다.`]);
  else if (M.cumEq[0] < 0) notes.push(["warn", `${N}년 안에 자기자본이 회수되지 않습니다. 단가·설치비·대출 조건을 다시 검토하세요.`]);
  if (neg.length) notes.push(["warn", `원리금 상환 때문에 순현금흐름이 마이너스인 해가 ${neg.length}번 있습니다(${neg[0].t}년차 등). 부족분을 보충할 자금이 필요합니다.`]);
  else if (M.loan > 0) notes.push(["ok", "모든 해에 원리금을 상환하고도 순현금흐름이 플러스입니다."]);
  if (M.loan > 0) {
    const dscr = M.rows[0].proj / M.pmt;
    notes.push([dscr >= 1.2 ? "ok" : "warn", `1년차 원리금상환비율(DSCR)은 ${fmt(dscr, 2)}배입니다. ${dscr >= 1.2 ? "상환 여력이 충분한 편입니다." : "금융권은 보통 1.2배 이상을 선호합니다."}`]);
  }
  if (M.irrEq !== null) notes.push([M.irrEq >= P.disc / 100 ? "ok" : "warn", `자기자본 IRR ${pct(M.irrEq)}는 할인율 ${fmt(P.disc, 1)}%보다 ${M.irrEq >= P.disc / 100 ? "높아 투자 가치가 있습니다" : "낮아 요구수익에 못 미칩니다"}.`]);
  if (M.loanOver) notes.push(["warn", `대출 기간(${P.term}년)이 분석기간(${N}년)보다 길어, 남은 대출 잔액은 ${N}년차에 일시 상환한다고 가정했습니다.`]);
  document.getElementById("notes").innerHTML = notes.map(([c, t]) => `<li class="${c}">${t}</li>`).join("");
}

function monthChart(M, w, h) {
  const mo = M.monthly;
  return barChart({
    w, h, values: mo.map(x => x.gen), labels: mo.map(x => x.m + "월"), yFmt: shortNum,
    aria: "월별 발전량 막대차트",
    tips: i => `<b>${mo[i].m}월</b><br>발전량 ${fmt(mo[i].gen)} kWh<br>일평균 ${fmt(mo[i].daily, 1)} kWh<br>매출 ${won(mo[i].rev)}`
  });
}

function renderGen() {
  const mo = M.monthly;
  mount("ch-month", (w, h) => monthChart(M, w, h));
  const mx = mo.reduce((a, b) => b.gen > a.gen ? b : a), mn = mo.reduce((a, b) => b.gen < a.gen ? b : a);
  document.getElementById("minmax").innerHTML =
    `<span>최대 <b>${mx.m}월 ${fmt(mx.gen)} kWh</b></span><span>최소 <b>${mn.m}월 ${fmt(mn.gen)} kWh</b></span><span>연 합계 <b>${fmt(M.rows[0].gen)} kWh</b></span>`;

  const yrs = M.rows.map(x => x.t);
  mount("ch-rev", (w, h) => lineChart({
    w, h, xs: yrs, includeZero: true, yFmt: shortNum, xTitle: "년차", aria: "연도별 매출 선차트",
    series: [
      { values: M.rows.map(x => x.rev), color: "var(--orange)", area: true },
      { values: M.rows.map(x => x.proj), color: "var(--navy)", dash: "5 4", width: 2 }
    ],
    tips: i => `<b>${yrs[i]}년차</b><br>발전량 ${fmt(M.rows[i].gen)} kWh<br>매출 ${won(M.rows[i].rev)}<br>운영비 차감 후 ${won(M.rows[i].proj)}`
  }));
}

function cumChart(M, w, h) {
  const yrs = M.cumEq.map((_, i) => i);
  return lineChart({
    w, h, xs: yrs, includeZero: true, yFmt: shortNum, xTitle: "년차", aria: "누적 현금흐름 선차트",
    zero: "0선 = 회수시점",
    mark: M.pbEq, markLabel: M.pbEq === null ? "" : `회수 ${fmt(M.pbEq, 1)}년`,
    series: [
      { values: M.cumPr, color: "#9aa6c0", dash: "5 4", width: 2, noPts: true },
      { values: M.cumEq, color: "var(--navy)", ptColor: v => v < 0 ? "var(--orange)" : "var(--navy)" }
    ],
    tips: i => `<b>${i}년차</b><br>자기자본 기준 ${won(M.cumEq[i])}<br>총사업비 기준 ${won(M.cumPr[i])}`
  });
}

function cashTableHTML(M) {
  const head =["연차", "발전량(kWh)", "매출", "운영비", "원리금상환", "순현금흐름", "누적"];
  const cell = v => `<td class="${v < 0 ? "neg" : ""}">${man(v)}</td>`;
  let pbRow = -1;
  for (let t = 1; t <= M.N; t++) if (M.cumEq[t - 1] < 0 && M.cumEq[t] >= 0) { pbRow = t; break; }
  let h = `<thead><tr>${head.map(x => `<th>${x}</th>`).join("")}</tr></thead><tbody>`;
  h += `<tr><td>0</td><td>—</td><td>—</td><td>—</td><td>—</td>${cell(-M.eq)}${cell(-M.eq)}</tr>`;
  M.rows.forEach(x => {
    h += `<tr${x.t === pbRow ? ' class="pb" title="자기자본 회수 시점"' : ""}><td>${x.t}</td><td>${fmt(x.gen)}</td><td>${man(x.rev)}</td><td>${man(x.opex)}</td><td>${man(x.pay)}</td>${cell(x.net)}${cell(x.cum)}</tr>`;
  });
  const sum = k => M.rows.reduce((s, x) => s + x[k], 0);
  h += `<tr class="tot"><td>합계</td><td>${fmt(sum("gen"))}</td><td>${man(sum("rev"))}</td><td>${man(sum("opex"))}</td><td>${man(sum("pay"))}</td><td>${man(sum("net"))}</td><td>${man(M.totalNet)}</td></tr></tbody>`;
  return h;
}

function renderCash() {
  mount("ch-cum", (w, h) => cumChart(M, w, h));
  document.getElementById("tbl").innerHTML = cashTableHTML(M);
}

const ICON_TREE = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="15" r="11" fill="#2e9e6b"/><circle cx="12" cy="22" r="7" fill="#3fb67e"/><circle cx="28" cy="22" r="7" fill="#3fb67e"/><rect x="18" y="24" width="4" height="13" rx="1.5" fill="#7a5a3a"/></svg>`;
const ICON_CAR = `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M5 25v-5l4-7c.6-1 1.5-1.5 2.6-1.5h16.8c1.100 0 2 .5 2.600 1.500l4 7v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" fill="#1d3d73"/><path d="M11 14h18l3 6H8z" fill="#cfe0ff"/><circle cx="12" cy="27" r="4" fill="#0f2547" stroke="#fff" stroke-width="1.500"/><circle cx="28" cy="27" r="4" fill="#0f2547" stroke="#fff" stroke-width="1.500"/></svg>`;
const ICON_CO2 = `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M12 29a7 7 0 0 1-1-13.900A9 9 0 0 1 28.300 13 7.500 7.500 0 0 1 28 29z" fill="#9bd5b6"/><text x="20" y="25" text-anchor="middle" font-size="9.500" font-weight="800" fill="#17623f">CO₂</text></svg>`;

function renderEnv() {
  const N = M.N, y1 = M.co2[0].kg / 1000, cum = M.co2[N - 1].cum / 1000;
  const t = v => fmt(v, v < 100 ? 1 : 0);
  const card = (icon, cls, label, val, unit, sub) =>
    `<div class="env ${cls}">${icon}<div><div class="k-l">${label}</div><div class="k-v">${val}<small> ${unit}</small></div><div class="k-s">${sub}</div></div></div>`;
  document.getElementById("env1").innerHTML =
    card(ICON_CO2, "", "CO₂ 감축량", t(y1), "tCO₂/년", `발전량 ${fmt(M.rows[0].gen)} kWh 기준`) +
    card(ICON_TREE, "", "소나무 환산", fmt(y1 * 1000 / TREE_KG_PER_YEAR), "그루", "1년간 흡수하는 양과 동일") +
    card(ICON_CAR, "n", "승용차 환산", fmt(y1 / CAR_T_PER_YEAR, 1), "대", "1년간 배출하는 양과 동일");
  document.getElementById("envT2").textContent = `누적 환경효과 (${N}년)`;
  document.getElementById("envD2").textContent = `성능저하를 반영한 ${N}년간 총 발전량 ${fmt(M.totalGen)} kWh 기준입니다.`;
  document.getElementById("env2").innerHTML =
    card(ICON_CO2, "", "누적 CO₂ 감축량", t(cum), "tCO₂", `${N}년간 합계`) +
    card(ICON_TREE, "", "소나무 환산", fmt(cum * 1000 / TREE_KG_PER_YEAR / N), "그루", `${N}년간 매년 심어 둔 효과`) +
    card(ICON_CAR, "n", "승용차 환산", fmt(cum / CAR_T_PER_YEAR / N, 1), "대", `${N}년간 운행하지 않은 효과`);

  const yrs = M.co2.map(x => x.t);
  mount("ch-co2", (w, h) => lineChart({
    w, h, xs: yrs, includeZero: true, yFmt: v => fmt(v), xTitle: "년차 (tCO₂)", aria: "누적 CO2 감축량 선차트",
    series: [{ values: M.co2.map(x => x.cum / 1000), color: "var(--green)", area: true }],
    tips: i => `<b>${yrs[i]}년차</b><br>연간 ${fmt(M.co2[i].kg / 1000, 1)} tCO₂<br>누적 ${fmt(M.co2[i].cum / 1000, 1)} tCO₂`
  }));
}

/* ---------- 탭 ---------- */
const TABS = ["summary", "gen", "cash", "env"];
const RENDER = { summary: renderSummary, gen: renderGen, cash: renderCash, env: renderEnv };
let active = "summary";

function setTab(name, focus) {
  active = name;
  TABS.forEach(k => {
    const on = k === name;
    const b = document.getElementById("t-" + k);
    b.setAttribute("aria-selected", on);
    b.tabIndex = on ? 0 : -1;
    document.getElementById("p-" + k).hidden = !on;
    if (on && focus) b.focus();
  });
  renderActive();
}
function renderActive() { if (M) RENDER[active](); }

TABS.forEach((k, i) => {
  const b = document.getElementById("t-" + k);
  b.addEventListener("click", () => setTab(k));
  b.addEventListener("keydown", e => {
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % TABS.length;
    if (e.key === "ArrowLeft") j = (i + TABS.length - 1) % TABS.length;
    if (e.key === "Home") j = 0;
    if (e.key === "End") j = TABS.length - 1;
    if (j !== null) { e.preventDefault(); setTab(TABS[j], true); }
  });
});

/* ---------- 패널 접기(모바일) ---------- */
const panel = document.getElementById("panel"), toggle = document.getElementById("panelToggle");
function setCollapsed(c) {
  panel.classList.toggle("collapsed", c);
  toggle.setAttribute("aria-expanded", String(!c));
  toggle.textContent = c ? "펼치기 ▾" : "접기 ▴";
}
toggle.addEventListener("click", e => { e.stopPropagation(); setCollapsed(!panel.classList.contains("collapsed")); });
document.getElementById("panelHead").addEventListener("click", e => {
  if (e.target.closest("button")) return;
  if (getComputedStyle(toggle).display !== "none") setCollapsed(!panel.classList.contains("collapsed"));
});
document.getElementById("resetBtn").addEventListener("click", e => { e.stopPropagation(); resetAll(); });


/* =====================================================================
   사용자 정보 · 보고서 · 이력관리 (서버 연동)
   ===================================================================== */
const UKEY = "grandsun.user.v1";
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const dtText = iso => { const d = new Date(iso); return isNaN(d) ? "-" : d.toLocaleString("ko-KR", { hour12: false }); };

/* 입력해 둔 사용자 정보를 다음 방문 때 채워 주기 위한 용도(이 브라우저에만 저장) */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장 불가 환경 */ } }

/* 서버 API 호출 */
async function api(url, opt) {
  const o = opt || {};
  const r = await fetch(url, {
    method: o.method || "GET",
    headers: o.body ? { "Content-Type": "application/json" } : {},
    body: o.body ? JSON.stringify(o.body) : undefined,
    credentials: "same-origin"
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 본문 없음 */ }
  if (!r.ok) {
    const err = new Error((j && j.error) || `요청에 실패했습니다 (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return j;
}

const USER_FIELDS = [
  { id: "name",    label: "이름",           req: true, max: 30, ph: "홍길동",                ac: "name" },
  { id: "org",     label: "소속",           max: 50, ph: "회사·기관명",                    ac: "organization" },
  { id: "contact", label: "연락처",         max: 40, ph: "전화번호 또는 이메일",           ac: "off" },
  { id: "project", label: "프로젝트·현장명", max: 50, ph: "예) 본사 지붕 태양광",           ac: "off" }
];
function userGroupHTML() {
  let h = `<div class="group"><h3>사용자 정보</h3>`;
  USER_FIELDS.forEach(f => {
    h += `<div class="field stack"><label for="u-${f.id}">${f.label}${f.req ? '<em class="req">필수</em>' : '<em class="opt">선택</em>'}</label>
      <div class="inp txt" id="uw-${f.id}"><input id="u-${f.id}" type="text" maxlength="${f.max}" placeholder="${f.ph}" autocomplete="${f.ac}"></div></div>`;
  });
  h += `<div class="field stack"><label for="u-ip">접속 IP<span class="sub">서버가 접속 시점에 자동으로 기록합니다 (수정 불가)</span></label>
    <div class="inp txt ro"><input id="u-ip" readonly value="확인 중…"></div></div>
    <div class="consent" id="consentRow"><label><input type="checkbox" id="u-consent"><span><em class="req">필수</em> 개인정보 수집·이용에 동의합니다.</span></label>
    <p class="note">수집 항목: 이름·소속·연락처·접속 IP·입력 조건 / 이용 목적: 보고서 생성 및 이력 관리 / 보관: 관리자가 삭제할 때까지 서버에 저장됩니다.</p></div></div>`;
  return h;
}
function readUser() { const u = {}; USER_FIELDS.forEach(f => { u[f.id] = $("u-" + f.id).value.trim().slice(0, f.max); }); return u; }
function initUser() {
  let saved = {};
  try { saved = JSON.parse(lsGet(UKEY) || "{}") || {}; } catch (e) { saved = {}; }
  USER_FIELDS.forEach(f => {
    const el = $("u-" + f.id);
    el.value = String(saved[f.id] || "").slice(0, f.max);
    el.addEventListener("input", () => { $("uw-" + f.id).classList.remove("invalid"); lsSet(UKEY, JSON.stringify(readUser())); });
  });
  $("u-consent").addEventListener("change", () => $("consentRow").classList.remove("invalid"));
}
async function loadWhoami() {
  try { $("u-ip").value = (await api("/api/whoami")).ip; }
  catch (e) { $("u-ip").value = "확인 불가 (서버 연결 실패)"; }
}

/* 토스트 */
let toastT = 0;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }

const baseInfo = p =>
  `${num(p.cap)}kW · 하루 ${num(p.hours)}시간 · SMP ${num(p.smp)}+REC ${num(p.rec)}원/kWh · 설치 ${won(p.unit)}/kW · 자기자본 ${num(p.equity)}% · ${p.years}년`;

/* ---------- 보고서 생성 ---------- */
let busy = false;
function needInfo(msg, focusId, markId) {
  setView("sim"); setCollapsed(false);
  $(markId).classList.add("invalid");
  $(focusId).scrollIntoView({ block: "center" });
  $(focusId).focus();
  toast(msg);
}
async function generateReport() {
  if (busy) return;
  const U = readUser();
  if (!U.name) return needInfo("보고서를 만들려면 사용자 이름을 입력해 주세요.", "u-name", "uw-name");
  if (!$("u-consent").checked) return needInfo("개인정보 수집·이용에 동의해 주세요.", "u-consent", "consentRow");
  busy = true; $("reportBtn").disabled = $("reportBtn2").disabled = true;
  try {
    const entry = await api("/api/reports", { method: "POST", body: { user: U, consent: true, inputs: sanitizeInputs(P) } });
    showReport(entry);
    toast("보고서가 생성되어 서버에 저장되었습니다.");
    if (ADMIN) checkSession();
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false; $("reportBtn").disabled = $("reportBtn2").disabled = false;
  }
}


let REP = null;
function reportHTML(e, m) {
  const u = e.user, p = m.p;
  const pairs = list => list.reduce((h, x, i) => (i % 2 === 0 ? h + "<tr>" : h) + `<th>${x[0]}</th><td>${x[1]}</td>` + (i % 2 === 1 || i === list.length - 1 ? "</tr>" : ""), "");
  const who = [
    ["이름", esc(u.name)], ["소속", esc(u.org) || "-"],
    ["연락처", esc(u.contact) || "-"], ["프로젝트·현장", esc(u.project) || "-"],
    ["접속 IP", esc(e.ip)], ["생성일시", esc(dtText(e.at))]
  ];
  const conds = ALL.map(f => [f.label, `${num(p[f.id])} ${f.unit}`]);
  return `
  <div class="rp-head">
    <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="11" fill="#f58220"/><g stroke="#f58220" stroke-width="3" stroke-linecap="round"><path d="M24 3v6M24 39v6M3 24h6M39 24h6M9.2 9.2l4.2 4.2M34.6 34.6l4.2 4.2M38.8 9.2l-4.2 4.2M13.4 34.6l-4.2 4.2"/></g></svg>
    <div><h2>GRANDSUN 태양광 사업성 분석 보고서</h2><p>보고서 번호 ${esc(e.id)} · 종합 사업성 시뮬레이터</p></div>
  </div>
  <h4>작성 정보</h4>
  <table class="kvt">${pairs(who)}</table>
  <h4>시뮬레이터 기초정보 (입력 조건)</h4>
  <table class="kvt">${pairs(conds)}</table>
  <h4>핵심 결과</h4>
  <div class="kpis">${kpiHTML(m)}</div>
  <h4>자금 구성</h4>
  <table class="kvt">${pairs([["총사업비", won(m.cost)], ["자기자본", `${won(m.eq)} (${num(p.equity)}%)`], ["대출금", won(m.loan)], ["연 원리금상환", m.loan > 0 ? won(m.pmt) : "-"]])}</table>
  <h4>월별 발전량 (1년차)</h4>
  <div class="chart" id="rp-month"></div>
  <h4>누적 현금흐름 (자기자본 기준)</h4>
  <div class="chart" id="rp-cum"></div>
  <h4>연도별 현금흐름표</h4>
  <p class="unit">금액 단위: 만원 · 0년차는 자기자본 투입 · 순현금흐름 = 매출 − 운영비 − 원리금상환</p>
  <div class="tbl-wrap"><table class="cf">${cashTableHTML(m)}</table></div>
  <div class="rp-foot">※ 본 보고서는 <b>간이 모델</b> 기준의 참고 자료입니다. 월별 발전량은 계절 보정계수로 추정했으며, 세금·보험·인버터 교체비·단가 변동·REC 가중치·보조금은 반영하지 않았습니다. 실제 투자 판단 전 전문가 검토가 필요합니다.</div>`;
}
function showReport(e) {
  const m = simulate(sanitizeInputs(e.inputs));
  REP = { e, m };
  $("reportBody").innerHTML = reportHTML(e, m);
  $("reportOv").hidden = false;
  document.body.classList.add("has-report");
  document.body.style.overflow = "hidden";
  $("reportOv").scrollTop = 0;
  drawReportCharts();
  $("repClose").focus();
}
function drawReportCharts() {
  if (!REP || $("reportOv").hidden) return;
  mount("rp-month", (w, h) => monthChart(REP.m, w, h));
  mount("rp-cum", (w, h) => cumChart(REP.m, w, h));
}
function closeReport() {
  $("reportOv").hidden = true; REP = null;
  document.body.classList.remove("has-report");
  document.body.style.overflow = "";
}


/* ---------- 이력관리 (관리자 전용) ---------- */
let ADMIN = false;
let HIST = { items: [], total: 0, all: 0 };
const OPEN = new Set();
let hseq = 0, hTimer = 0;

function setBadge(n) { const b = $("histCount"); b.hidden = n == null; if (n != null) b.textContent = n; }
async function checkSession() {
  try {
    const j = await api("/api/admin/session");
    ADMIN = !!j.admin;
    setBadge(ADMIN ? j.total : null);
  } catch (e) { ADMIN = false; setBadge(null); }
}
async function showHist() {
  await checkSession();
  $("adminLogin").hidden = ADMIN;
  $("histMain").hidden = !ADMIN;
  if (ADMIN) await fetchHist(true);
  else $("adminPw").focus();
}
async function fetchHist(reset) {
  const my = ++hseq;
  const offset = reset ? 0 : HIST.items.length;
  try {
    const j = await api(`/api/history?q=${encodeURIComponent($("hq").value.trim())}&limit=50&offset=${offset}`);
    if (my !== hseq) return;   // 더 최근 요청이 있으면 무시
    HIST = { items: reset ? j.items : HIST.items.concat(j.items), total: j.total, all: j.all };
    setBadge(j.all);
    renderHist();
  } catch (e) {
    if (e.status === 401) { toast("로그인이 만료되었습니다. 다시 로그인해 주세요."); showHist(); }
    else toast(e.message);
  }
}
function renderHist() {
  const q = $("hq").value.trim();
  $("hcnt").textContent = q ? `검색 ${HIST.total}건 / 전체 ${HIST.all}건` : `총 ${HIST.all}건`;
  $("moreBtn").hidden = HIST.items.length >= HIST.total;
  const tbl = $("htbl");
  if (!HIST.items.length) {
    tbl.innerHTML = `<tbody><tr><td class="empty">${HIST.all ? "검색 결과가 없습니다." : "아직 생성된 보고서가 없습니다."}</td></tr></tbody>`;
    return;
  }
  const head = [["No", ""], ["생성일시", "l"], ["사용자 이름", "l"], ["소속", "l"], ["접속 IP", "l"], ["시뮬레이터 기초정보", "l"], ["총사업비", ""], ["자기자본 IRR", ""], ["관리", ""]];
  let h = `<thead><tr>${head.map(([t, c]) => `<th class="${c}">${t}</th>`).join("")}</tr></thead><tbody>`;
  HIST.items.forEach((e, i) => {
    const p = sanitizeInputs(e.inputs), r = e.results || {};
    const id = esc(e.id);
    h += `<tr><td>${HIST.total - i}</td><td class="l">${esc(dtText(e.at))}</td><td class="l"><b>${esc(e.user.name)}</b></td><td class="l">${esc(e.user.org) || "-"}</td>
      <td class="l">${esc(e.ip)}</td><td class="wrapc">${esc(baseInfo(p))}</td><td>${won(r.cost != null ? r.cost : p.cap * p.unit)}</td><td>${pct(r.irrEq)}</td>
      <td class="acts"><button type="button" class="btn" data-act="det" data-id="${id}">${OPEN.has(e.id) ? "닫기" : "상세"}</button><button type="button" class="btn" data-act="rep" data-id="${id}">보고서</button><button type="button" class="btn" data-act="load" data-id="${id}">불러오기</button><button type="button" class="btn danger" data-act="del" data-id="${id}">삭제</button></td></tr>`;
    if (OPEN.has(e.id)) {
      const kv = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
      const pb = v => v == null ? "—" : fmt(v, 1) + "년";
      h += `<tr class="det"><td colspan="9">
        <p class="dsec">사용자 정보</p>
        <div class="dgrid">${kv("이름", esc(e.user.name))}${kv("소속", esc(e.user.org) || "-")}${kv("연락처", esc(e.user.contact) || "-")}${kv("프로젝트·현장", esc(e.user.project) || "-")}${kv("접속 IP", esc(e.ip))}${kv("생성일시", esc(dtText(e.at)))}${kv("보고서 번호", id)}</div>
        <p class="dsec">시뮬레이터 기초정보</p>
        <div class="dgrid">${ALL.map(f => kv(f.label, `${num(p[f.id])} ${f.unit}`)).join("")}</div>
        <p class="dsec">주요 결과</p>
        <div class="dgrid">${kv("총사업비", won(r.cost))}${kv("1년차 매출", won(r.rev1))}${kv("단순 회수기간", pb(r.pbPr))}${kv("자기자본 회수기간", pb(r.pbEq))}${kv("자기자본 IRR / 프로젝트 IRR", pct(r.irrEq) + " / " + pct(r.irrPr))}${kv("자기자본 NPV", won(r.npvEq))}${kv("LCOE", r.lcoe == null ? "—" : fmt(r.lcoe, 1) + " 원/kWh")}${kv("총 순이익", won(r.totalNet))}</div>
      </td></tr>`;
    }
  });
  tbl.innerHTML = h + "</tbody>";
}

async function adminLogin(ev) {
  ev.preventDefault();
  const err = $("loginErr"); err.hidden = true;
  try {
    await api("/api/admin/login", { method: "POST", body: { password: $("adminPw").value } });
    $("adminPw").value = "";
    await showHist();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
}
async function adminLogout() {
  try { await api("/api/admin/logout", { method: "POST", body: {} }); } catch (e) { /* 무시 */ }
  HIST = { items: [], total: 0, all: 0 };
  await showHist();
}
async function exportCSV() {
  try {
    const r = await fetch("/api/history.csv", { credentials: "same-origin" });
    if (r.status === 401) { toast("로그인이 만료되었습니다."); return showHist(); }
    if (!r.ok) throw new Error("CSV를 만들지 못했습니다.");
    const blob = await r.blob();
    const m = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : "grandsun_history.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast(e.message); }
}
async function delOne(e) {
  if (!confirm(`'${e.user.name}' 님의 이력을 삭제할까요?`)) return;
  try { await api("/api/history/" + encodeURIComponent(e.id), { method: "DELETE" }); OPEN.delete(e.id); await fetchHist(true); toast("삭제했습니다."); }
  catch (err) { toast(err.message); }
}
async function delAll() {
  if (!HIST.all) return;
  if (!confirm(`서버에 저장된 이력 ${HIST.all}건을 모두 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try { await api("/api/history", { method: "DELETE" }); OPEN.clear(); await fetchHist(true); toast("전체 삭제했습니다."); }
  catch (err) { toast(err.message); }
}

function loadEntry(e) {
  const inp = sanitizeInputs(e.inputs);
  ALL.forEach(f => {
    P[f.id] = inp[f.id];
    $("in-" + f.id).value = fmt(inp[f.id], f.dec);
    $("w-" + f.id).classList.remove("invalid");
  });
  closeReport(); setView("sim"); update();
  toast("이력의 입력 조건을 불러왔습니다.");
}

/* ---------- 화면 전환 · 이벤트 ---------- */
function setView(v) {
  const h = v === "hist";
  $("viewSim").hidden = h; $("viewHist").hidden = !h; $("reportBtn").hidden = h;
  $("nv-sim").setAttribute("aria-current", h ? "false" : "page");
  $("nv-hist").setAttribute("aria-current", h ? "page" : "false");
  if (h) showHist(); else renderActive();
  window.scrollTo(0, 0);
}

function initApp() {
  initUser();
  $("nv-sim").addEventListener("click", () => setView("sim"));
  $("nv-hist").addEventListener("click", () => setView("hist"));
  $("reportBtn").addEventListener("click", generateReport);
  $("reportBtn2").addEventListener("click", generateReport);
  $("printBtn").addEventListener("click", () => window.print());
  $("repClose").addEventListener("click", closeReport);
  $("repHist").addEventListener("click", () => { closeReport(); setView("hist"); });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !$("reportOv").hidden) closeReport(); });
  $("loginForm").addEventListener("submit", adminLogin);
  $("logoutBtn").addEventListener("click", adminLogout);
  $("hq").addEventListener("input", () => { clearTimeout(hTimer); hTimer = setTimeout(() => fetchHist(true), 250); });
  $("moreBtn").addEventListener("click", () => fetchHist(false));
  $("csvBtn").addEventListener("click", exportCSV);
  $("clearBtn").addEventListener("click", delAll);
  $("htbl").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    const e = HIST.items.find(x => x.id === b.dataset.id);
    if (!e) return;
    const act = b.dataset.act;
    if (act === "det") { OPEN.has(e.id) ? OPEN.delete(e.id) : OPEN.add(e.id); renderHist(); }
    else if (act === "rep") showReport(e);
    else if (act === "load") loadEntry(e);
    else if (act === "del") delOne(e);
  });
  loadWhoami();
  checkSession();
}

/* ---------- 실행 ---------- */
function update() {
  readInputs();
  M = simulate(P);
  updateHints();
  renderActive();
}
let rz = 0;
window.addEventListener("resize", () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { renderActive(); drawReportCharts(); }); });

buildForm();
initApp();
setCollapsed(window.matchMedia("(max-width:959px)").matches);
update();
