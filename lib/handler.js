"use strict";
/* =====================================================================
   API 처리 로직 — 로컬 서버(server.js)와 Vercel Functions(api/)가 함께 사용합니다.
   서버리스에서는 요청마다 다른 인스턴스가 처리할 수 있으므로
   - 관리자 세션: 서명된 쿠키(상태 저장 없음)
   - 요청 제한: 저장소(DB)에 기록
   를 사용합니다.
   ===================================================================== */
const crypto = require("node:crypto");
const GS = require("../public/model.js");

const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = "gs_admin";
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "g");
const cleanStr = (v, max) => (typeof v === "string" ? v.replace(CONTROL, " ").trim().slice(0, max) : "");
const sha256 = s => crypto.createHash("sha256").update(String(s)).digest();
const b64u = buf => Buffer.from(buf).toString("base64url");

function json(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  }, headers));
  res.end(body);
}
const fail = (res, status, msg, headers) => json(res, status, { error: msg }, headers);
const httpError = (status, message) => Object.assign(new Error(message), { status });

/* Vercel은 JSON 본문을 미리 파싱해 req.body에 넣어 주므로 둘 다 처리 */
async function readJson(req, limit) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw httpError(415, "Content-Type은 application/json이어야 합니다.");
  if (req.body !== undefined && req.body !== null) {
    let b = req.body;
    if (Buffer.isBuffer(b)) b = b.toString("utf8");
    if (typeof b === "string") {
      if (b.length > limit) throw httpError(413, "요청이 너무 큽니다.");
      try { return JSON.parse(b || "{}"); } catch (e) { throw httpError(400, "JSON 형식이 올바르지 않습니다."); }
    }
    if (JSON.stringify(b).length > limit) throw httpError(413, "요청이 너무 큽니다.");
    return b;
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(httpError(413, "요청이 너무 큽니다.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(httpError(400, "JSON 형식이 올바르지 않습니다.")); }
    });
    req.on("error", reject);
  });
}

/* CSV */
function csvCell(v, isText) {
  let s = String(v == null ? "" : v);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // 엑셀 수식 주입 방지
  return '"' + s.replace(/"/g, '""') + '"';
}
const kst = iso => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
function buildCsv(entries) {
  const head = ["번호", "생성일시", "사용자 이름", "소속", "연락처", "프로젝트·현장", "접속 IP", "보고서 번호",
    ...GS.ALL.map(f => `${f.label}(${f.unit})`),
    "총사업비(원)", "1년차 매출(원)", "단순 회수기간(년)", "자기자본 회수기간(년)", "자기자본 IRR(%)", "자기자본 NPV(원)", "LCOE(원/kWh)"];
  const lines = [head.map(x => csvCell(x)).join(",")];
  const t = x => csvCell(x, true);
  const n = x => csvCell(x == null || !isFinite(x) ? "" : Math.round(x * 100) / 100);
  entries.forEach((e, i) => {
    const r = e.results || {};
    lines.push([n(entries.length - i), t(kst(e.at)), t(e.user.name), t(e.user.org), t(e.user.contact), t(e.user.project), t(e.ip), t(e.id),
      ...GS.ALL.map(f => n(e.inputs[f.id])),
      n(r.cost), n(r.rev1), n(r.pbPr), n(r.pbEq), n(r.irrEq == null ? null : r.irrEq * 100), n(r.npvEq), n(r.lcoe)].join(","));
  });
  return "﻿" + lines.join("\r\n");
}

/**
 * cfg: { adminPassword, trustProxy, onVercel, secureCookie, retentionDays, log }
 * store: 비동기 저장소(lib/store-*.js)
 * 반환: async (req, res, url) => void
 */
function createApiHandler(cfg, store) {
  const adminHash = cfg.adminPassword ? sha256(cfg.adminPassword) : null;
  const sessionKey = cfg.adminPassword ? sha256("gs-session-v1:" + cfg.adminPassword) : null;
  const log = cfg.log || (() => {});
  let ready = null;
  const init = () => (ready || (ready = store.init().catch(e => { ready = null; throw e; })));

  function clientIp(req) {
    let ip = "";
    const h = req.headers;
    if (cfg.onVercel) {
      ip = String(h["x-vercel-forwarded-for"] || h["x-real-ip"] || String(h["x-forwarded-for"] || "").split(",")[0]).split(",")[0].trim();
    } else if (cfg.trustProxy > 0) {
      const xff = String(h["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
      ip = xff[xff.length - cfg.trustProxy] || "";
    }
    if (!ip) ip = req.socket && req.socket.remoteAddress || "";
    ip = ip.replace(/^::ffff:/i, "");
    return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : "확인 불가";
  }

  /* 서명된 세션 쿠키 */
  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || "").split(";").forEach(p => {
      const i = p.indexOf("=");
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return out;
  }
  const sign = payload => b64u(crypto.createHmac("sha256", sessionKey).update(payload).digest());
  function makeToken() {
    const payload = b64u(JSON.stringify({ exp: Date.now() + SESSION_MS, n: crypto.randomBytes(8).toString("hex") }));
    return payload + "." + sign(payload);
  }
  function isAdmin(req) {
    if (!sessionKey) return false;
    const t = parseCookies(req)[COOKIE];
    if (!t) return false;
    const [payload, sig] = t.split(".");
    if (!payload || !sig) return false;
    const want = Buffer.from(sign(payload)), got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp > Date.now(); } catch (e) { return false; }
  }
  const isHttps = req => cfg.secureCookie || cfg.onVercel || (cfg.trustProxy > 0 && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
  const cookieHeader = (req, value, maxAgeSec) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}` + (isHttps(req) ? "; Secure" : "");
  const passwordOk = input => crypto.timingSafeEqual(sha256(input), adminHash);
  function sameOrigin(req) {
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
  }

  return async function handle(req, res, url) {
    const ip = clientIp(req);
    const route = req.method + " " + url.pathname.replace(/\/+$/, "");

    if (route === "GET /api/whoami") return json(res, 200, { ip });   // DB 없이도 응답
    await init();
    if (req.method !== "GET" && !sameOrigin(req)) return fail(res, 403, "허용되지 않은 요청 출처입니다.");

    /* 보고서 생성 (누구나) */
    if (route === "POST /api/reports") {
      if (await store.rateCount("rep:" + ip, 3600000) >= 20) return fail(res, 429, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
      const body = await readJson(req, 32 * 1024);
      const u = body && body.user || {};
      const user = { name: cleanStr(u.name, 30), org: cleanStr(u.org, 50), contact: cleanStr(u.contact, 40), project: cleanStr(u.project, 50) };
      if (!user.name) return fail(res, 400, "사용자 이름을 입력해 주세요.");
      if (body.consent !== true) return fail(res, 400, "개인정보 수집·이용에 동의해 주세요.");
      /* 입력값은 서버에서 다시 검증하고, 결과도 서버가 직접 계산합니다. */
      const inputs = GS.sanitizeInputs(body.inputs);
      const results = GS.summarize(GS.simulate(inputs));
      const id = "R" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString("hex").toUpperCase();
      const at = new Date().toISOString();
      await store.rateAdd("rep:" + ip);
      await store.insertReport({ id, at, user, ip, inputs, results });
      log(`[report] ${id} ip=${ip}`);
      if (cfg.retentionDays && Math.random() < 0.05) store.purgeOld(new Date(Date.now() - cfg.retentionDays * 86400000).toISOString()).catch(() => {});
      return json(res, 201, { id, at, user, ip, inputs, results });
    }

    /* 관리자 로그인 */
    if (route === "POST /api/admin/login") {
      if (!adminHash) return fail(res, 503, "관리자 비밀번호(ADMIN_PASSWORD)가 서버에 설정되지 않았습니다.");
      const key = "login:" + ip;
      if (await store.rateCount(key, 900000) >= 5) return fail(res, 429, "로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.");
      const body = await readJson(req, 2048);
      if (typeof body.password !== "string" || !passwordOk(body.password)) {
        await store.rateAdd(key);   // 실패 횟수 기록
        return fail(res, 401, "비밀번호가 올바르지 않습니다.");
      }
      await store.rateClear(key);
      return json(res, 200, { admin: true }, { "Set-Cookie": cookieHeader(req, makeToken(), SESSION_MS / 1000) });
    }
    if (route === "POST /api/admin/logout") return json(res, 200, { admin: false }, { "Set-Cookie": cookieHeader(req, "", 0) });
    if (route === "GET /api/admin/session") {
      const admin = isAdmin(req);
      return json(res, 200, { admin, total: admin ? await store.allCount() : undefined });
    }

    /* 이하 관리자 전용 */
    const p = url.pathname.replace(/\/+$/, "");
    if (p === "/api/history" || p === "/api/history.csv" || p.startsWith("/api/history/")) {
      if (!isAdmin(req)) return fail(res, 401, "관리자 로그인이 필요합니다.");

      if (route === "GET /api/history") {
        const q = cleanStr(url.searchParams.get("q") || "", 60);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
        const { total, items } = await store.queryReports(q, limit, offset);
        return json(res, 200, { total, all: await store.allCount(), items });
      }
      if (route === "GET /api/history.csv") {
        const { items } = await store.queryReports("", null, 0);
        const d = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, "");
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="grandsun_history_${d}.csv"`,
          "Cache-Control": "no-store"
        });
        return res.end(buildCsv(items));
      }
      if (route === "DELETE /api/history") {
        const n = await store.deleteAll();
        log(`[admin] 전체 삭제 ${n}건 ip=${ip}`);
        return json(res, 200, { deleted: n });
      }
      if (req.method === "DELETE" && p.startsWith("/api/history/")) {
        const id = decodeURIComponent(p.slice("/api/history/".length));
        if (!(await store.deleteReport(id))) return fail(res, 404, "이력을 찾을 수 없습니다.");
        log(`[admin] 삭제 ${id} ip=${ip}`);
        return json(res, 200, { deleted: 1 });
      }
    }
    return fail(res, 404, "존재하지 않는 API입니다.");
  };
}

module.exports = { createApiHandler, json, fail };
