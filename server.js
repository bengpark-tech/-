"use strict";
/* =====================================================================
   GRANDSUN 태양광 시뮬레이터 — 로컬/자체 서버 실행용
   (Vercel에서는 이 파일 대신 vercel.json + api/ 폴더가 사용됩니다.)
   - 정적 파일(public/) 제공 + /api/* 처리(lib/handler.js)
   - 기본 저장소: SQLite 파일(Node.js 22.13+ 내장 node:sqlite)
     STORE=postgres 로 지정하면 DATABASE_URL의 Postgres를 사용합니다.
   ===================================================================== */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createApiHandler, fail } = require("./lib/handler");

/* ---------- 설정 ---------- */
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";           // 외부 공개 시 HOST=0.0.0.0
const TRUST_PROXY = Math.max(0, Number(process.env.TRUST_PROXY) || 0); // 앞단 프록시 개수(0=신뢰 안 함)
const RETENTION_DAYS = Math.max(0, Number(process.env.RETENTION_DAYS) || 0);  // 0=삭제 안 함
const PUBLIC_DIR = path.join(__dirname, "public");

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
let generatedPassword = false;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString("base64url");
  generatedPassword = true;
}

let store;
if (process.env.STORE === "postgres") {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) { console.error("STORE=postgres 이지만 DATABASE_URL이 없습니다."); process.exit(1); }
  store = require("./lib/store-pg").createPgStore(url);
} else {
  store = require("./lib/store-sqlite").createSqliteStore(path.resolve(process.env.DB_PATH || path.join(__dirname, "data", "grandsun.db")));
}

const api = createApiHandler({
  adminPassword: ADMIN_PASSWORD,
  trustProxy: TRUST_PROXY,
  secureCookie: process.env.COOKIE_SECURE === "1",
  retentionDays: RETENTION_DAYS,
  log: console.log
}, store);

async function purgeOld() {
  if (!RETENTION_DAYS) return;
  try {
    const n = await store.purgeOld(new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString());
    if (n) console.log(`보관 기간(${RETENTION_DAYS}일)이 지난 이력 ${n}건을 삭제했습니다.`);
  } catch (e) { console.error(e); }
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
    if (url.pathname === "/healthz") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":true}'); }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
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
  console.log(`저장소: ${store.kind}${store.path ? " (" + store.path + ")" : ""}`);
  if (generatedPassword) {
    console.log("\n※ ADMIN_PASSWORD 환경변수가 없어 임시 관리자 비밀번호를 만들었습니다(서버를 다시 켜면 바뀝니다):");
    console.log("   " + ADMIN_PASSWORD + "\n");
  }
  if (HOST === "0.0.0.0" && TRUST_PROXY === 0) console.log("참고: 외부에 공개하며 리버스 프록시를 쓴다면 TRUST_PROXY=1 로 설정해야 실제 접속 IP가 기록됩니다.");
});

function shutdown() { server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
