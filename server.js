"use strict";
/* =====================================================================
   GRANDSUN 태양광 시뮬레이터 서버
   - 정적 파일(public/) 제공
   - 보고서 생성 시 사용자 정보·접속 IP·시뮬레이터 기초정보를 SQLite에 저장
   - 이력 조회·삭제·CSV는 관리자 로그인 후에만 가능
   외부 패키지 없이 Node.js 22.13+ (내장 node:sqlite)만 사용합니다.
   ===================================================================== */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const GS = require("./public/model.js");

/* ---------- 설정 ---------- */
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";           // 외부 공개 시 HOST=0.0.0.0
const TRUST_PROXY = Math.max(0, Number(process.env.TRUST_PROXY) || 0); // 앞단 프록시 개수(0=신뢰 안 함)
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, "data", "grandsun.db"));
const RETENTION_DAYS = Math.max(0, Number(process.env.RETENTION_DAYS) || 0);  // 0=삭제 안 함
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_MS = 8 * 60 * 60 * 1000;

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
let generatedPassword = false;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString("base64url");
  generatedPassword = true;
}
const adminHash = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();

/* ---------- DB ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    name       TEXT NOT NULL,
    org        TEXT NOT NULL DEFAULT '',
    contact    TEXT NOT NULL DEFAULT '',
    project    TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL,
    inputs     TEXT NOT NULL,
    results    TEXT NOT NULL,
    consent    INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);
`);
const stmt = {
  insert: db.prepare("INSERT INTO reports (id, created_at, name, org, contact, project, ip, inputs, results, consent) VALUES (?,?,?,?,?,?,?,?,?,1)"),
  del: db.prepare("DELETE FROM reports WHERE id = ?"),
  delAll: db.prepare("DELETE FROM reports"),
  purge: db.prepare("DELETE FROM reports WHERE created_at < ?")
};

function rowToEntry(r) {
  return {
    id: r.id, at: r.created_at,
    user: { name: r.name, org: r.org, contact: r.contact, project: r.project },
    ip: r.ip, inputs: JSON.parse(r.inputs), results: JSON.parse(r.results)
  };
}
function escapeLike(s) { return s.replace(/[\\%_]/g, c => "\\" + c); }
function queryReports(q, limit, offset) {
  let where = "", params = [];
  if (q) {
    const like = "%" + escapeLike(q) + "%";
    where = " WHERE name LIKE ? ESCAPE '\\' OR org LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\'";
    params = [like, like, like, like];
  }
  const total = db.prepare("SELECT COUNT(*) AS n FROM reports" + where).get(...params).n;
  const rows = limit == null
    ? db.prepare("SELECT * FROM reports" + where + " ORDER BY created_at DESC, id DESC").all(...params)
    : db.prepare("SELECT * FROM reports" + where + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(...params, limit, offset);
  return { total, rows };
}
function purgeOld() {
  if (!RETENTION_DAYS) return;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const r = stmt.purge.run(cutoff);
  if (r.changes) console.log(`보관 기간(${RETENTION_DAYS}일)이 지난 이력 ${r.changes}건을 삭제했습니다.`);
}

/* ---------- 유틸 ---------- */
const CONTROL = new RegExp("[\u0000-\u001f\u007f\u2028\u2029]", "g");
const cleanStr = (v, max) => (typeof v === "string" ? v.replace(CONTROL, " ").trim().slice(0, max) : "");

function clientIp(req) {
  let ip = "";
  if (TRUST_PROXY > 0) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
    ip = xff[xff.length - TRUST_PROXY] || "";
  }
  if (!ip) ip = req.socket.remoteAddress || "";
  ip = ip.replace(/^::ffff:/i, "");
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : "확인 불가";
}

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

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return reject(Object.assign(new Error("Content-Type은 application/json이어야 합니다."), { status: 415 }));
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("요청이 너무 큽니다."), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(Object.assign(new Error("JSON 형식이 올바르지 않습니다."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

/* 간단한 메모리 기반 요청 제한 */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now); buckets.set(key, arr);
  return false;
}
function failedCount(key, windowMs) {
  const now = Date.now();
  return (buckets.get(key) || []).filter(t => now - t < windowMs).length;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) { const f = arr.filter(t => now - t < 3600000); f.length ? buckets.set(k, f) : buckets.delete(k); }
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 10 * 60 * 1000).unref();

/* ---------- 관리자 세션 ---------- */
const sessions = new Map();
const COOKIE = "gs_admin";
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function isAdmin(req) {
  const t = parseCookies(req)[COOKIE];
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function isHttps(req) {
  return process.env.COOKIE_SECURE === "1" || (TRUST_PROXY > 0 && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
}
function cookieHeader(req, value, maxAgeSec) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}` + (isHttps(req) ? "; Secure" : "");
}
function passwordOk(input) {
  const h = crypto.createHash("sha256").update(String(input)).digest();
  return crypto.timingSafeEqual(h, adminHash);
}
/* 교차 사이트 요청 차단: Origin이 있으면 Host와 같아야 함 */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

/* ---------- CSV ---------- */
function csvCell(v, isText) {
  let s = String(v == null ? "" : v);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // 엑셀 수식 주입 방지
  return '"' + s.replace(/"/g, '""') + '"';
}
const kst = iso => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
function buildCsv(rows) {
  const head = ["번호", "생성일시", "사용자 이름", "소속", "연락처", "프로젝트·현장", "접속 IP", "보고서 번호",
    ...GS.ALL.map(f => `${f.label}(${f.unit})`),
    "총사업비(원)", "1년차 매출(원)", "단순 회수기간(년)", "자기자본 회수기간(년)", "자기자본 IRR(%)", "자기자본 NPV(원)", "LCOE(원/kWh)"];
  const lines = [head.map(x => csvCell(x)).join(",")];
  const t = x => csvCell(x, true);
  const n = x => csvCell(x == null || !isFinite(x) ? "" : Math.round(x * 100) / 100);
  rows.forEach((row, i) => {
    const e = rowToEntry(row), r = e.results || {};
    lines.push([n(rows.length - i), t(kst(e.at)), t(e.user.name), t(e.user.org), t(e.user.contact), t(e.user.project), t(e.ip), t(e.id),
      ...GS.ALL.map(f => n(e.inputs[f.id])),
      n(r.cost), n(r.rev1), n(r.pbPr), n(r.pbEq), n(r.irrEq == null ? null : r.irrEq * 100), n(r.npvEq), n(r.lcoe)].join(","));
  });
  return "﻿" + lines.join("\r\n");
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const ip = clientIp(req);
  const route = req.method + " " + url.pathname;

  if (route === "GET /api/whoami") return json(res, 200, { ip });

  if (req.method !== "GET" && !sameOrigin(req)) return fail(res, 403, "허용되지 않은 요청 출처입니다.");

  /* 보고서 생성 (누구나) */
  if (route === "POST /api/reports") {
    if (limited("rep:" + ip, 20, 60 * 60 * 1000)) return fail(res, 429, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    const body = await readJson(req);
    const u = body && body.user || {};
    const user = { name: cleanStr(u.name, 30), org: cleanStr(u.org, 50), contact: cleanStr(u.contact, 40), project: cleanStr(u.project, 50) };
    if (!user.name) return fail(res, 400, "사용자 이름을 입력해 주세요.");
    if (body.consent !== true) return fail(res, 400, "개인정보 수집·이용에 동의해 주세요.");
    /* 입력값은 서버에서 다시 검증하고, 결과도 서버가 직접 계산합니다. */
    const inputs = GS.sanitizeInputs(body.inputs);
    const results = GS.summarize(GS.simulate(inputs));
    const id = "R" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString("hex").toUpperCase();
    const at = new Date().toISOString();
    stmt.insert.run(id, at, user.name, user.org, user.contact, user.project, ip, JSON.stringify(inputs), JSON.stringify(results));
    console.log(`[report] ${id} ip=${ip}`);
    return json(res, 201, { id, at, user, ip, inputs, results });
  }

  /* 관리자 로그인 */
  if (route === "POST /api/admin/login") {
    const key = "login:" + ip;
    if (failedCount(key, 15 * 60 * 1000) >= 5) return fail(res, 429, "로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.");
    const body = await readJson(req, 2048);
    if (typeof body.password !== "string" || !passwordOk(body.password)) {
      limited(key, 1e9, 15 * 60 * 1000);   // 실패 횟수 기록
      return fail(res, 401, "비밀번호가 올바르지 않습니다.");
    }
    buckets.delete(key);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_MS);
    return json(res, 200, { admin: true }, { "Set-Cookie": cookieHeader(req, token, SESSION_MS / 1000) });
  }
  if (route === "POST /api/admin/logout") {
    const t = parseCookies(req)[COOKIE];
    if (t) sessions.delete(t);
    return json(res, 200, { admin: false }, { "Set-Cookie": cookieHeader(req, "", 0) });
  }
  if (route === "GET /api/admin/session") {
    const admin = isAdmin(req);
    return json(res, 200, { admin, total: admin ? db.prepare("SELECT COUNT(*) AS n FROM reports").get().n : undefined });
  }

  /* 이하 관리자 전용 */
  if (url.pathname === "/api/history" || url.pathname === "/api/history.csv" || url.pathname.startsWith("/api/history/")) {
    if (!isAdmin(req)) return fail(res, 401, "관리자 로그인이 필요합니다.");

    if (route === "GET /api/history") {
      const q = cleanStr(url.searchParams.get("q") || "", 60);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const { total, rows } = queryReports(q, limit, Math.floor(offset));
      const all = db.prepare("SELECT COUNT(*) AS n FROM reports").get().n;
      return json(res, 200, { total, all, items: rows.map(rowToEntry) });
    }
    if (route === "GET /api/history.csv") {
      const { rows } = queryReports("", null, 0);
      const d = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, "");
      const body = buildCsv(rows);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="grandsun_history_${d}.csv"`,
        "Cache-Control": "no-store"
      });
      return res.end(body);
    }
    if (route === "DELETE /api/history") {
      const r = stmt.delAll.run();
      console.log(`[admin] 전체 삭제 ${r.changes}건 ip=${ip}`);
      return json(res, 200, { deleted: Number(r.changes) });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/history/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/history/".length));
      const r = stmt.del.run(id);
      if (!r.changes) return fail(res, 404, "이력을 찾을 수 없습니다.");
      console.log(`[admin] 삭제 ${id} ip=${ip}`);
      return json(res, 200, { deleted: 1 });
    }
  }
  return fail(res, 404, "존재하지 않는 API입니다.");
}

/* ---------- 정적 파일 ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"
};
const SEC_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin"
};
function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.includes("\0")) { res.writeHead(400); return res.end(); }
  if (rel === "/") rel = "/index.html";
  const file = path.resolve(PUBLIC_DIR, "." + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("404 Not Found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-cache"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- 서버 ---------- */
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch (e) { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e && e.status) return fail(res, e.status, e.message);
    console.error(e);
    if (!res.headersSent) return fail(res, 500, "서버 오류가 발생했습니다.");
    res.end();
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;

purgeOld();
setInterval(purgeOld, 24 * 3600 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`GRANDSUN 태양광 시뮬레이터 서버 실행 중: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  if (generatedPassword) {
    console.log("\n※ ADMIN_PASSWORD 환경변수가 없어 임시 관리자 비밀번호를 만들었습니다(서버를 다시 켜면 바뀝니다):");
    console.log("   " + ADMIN_PASSWORD + "\n");
  }
  if (HOST === "0.0.0.0" && TRUST_PROXY === 0) console.log("참고: 외부에 공개하며 리버스 프록시를 쓴다면 TRUST_PROXY=1 로 설정해야 실제 접속 IP가 기록됩니다.");
});

function shutdown() { server.close(() => { try { db.close(); } catch (e) { /* noop */ } process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
