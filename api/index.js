"use strict";
/* Vercel Functions 진입점: vercel.json의 rewrite로 /api/* 모든 요청이 이 함수로 들어옵니다.
   원래 경로는 쿼리 __p 로 전달되며, 저장소는 Neon Postgres입니다. */
const { createApiHandler, fail } = require("../lib/handler");
const { createPgStore } = require("../lib/store-pg");

let handler = null;
function getHandler() {
  if (handler) return handler;
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) return null;
  handler = createApiHandler({
    adminPassword: process.env.ADMIN_PASSWORD || "",
    onVercel: true,
    retentionDays: Math.max(0, Number(process.env.RETENTION_DAYS) || 0),
    log: console.log
  }, createPgStore(dbUrl));
  return handler;
}

module.exports = async (req, res) => {
  const h = getHandler();
  if (!h) return fail(res, 503, "데이터베이스(DATABASE_URL)가 연결되지 않았습니다.");
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.searchParams.has("__p")) {
      url.pathname = "/api/" + url.searchParams.get("__p");
      url.searchParams.delete("__p");
    }
    await h(req, res, url);
  } catch (e) {
    if (e && e.status) return fail(res, e.status, e.message);
    console.error(e);
    if (!res.headersSent) return fail(res, 500, "서버 오류가 발생했습니다.");
    res.end();
  }
};
