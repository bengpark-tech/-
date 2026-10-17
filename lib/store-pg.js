"use strict";
/* Vercel 배포용 저장소: Neon Postgres (Vercel Marketplace). HTTP 방식 드라이버라 서버리스에 적합합니다. */
const { neon } = require("@neondatabase/serverless");

function escapeLike(s) { return s.replace(/[\\%_]/g, c => "\\" + c); }
function rowToEntry(r) {
  return {
    id: r.id, at: r.created_at,
    user: { name: r.name, org: r.org, contact: r.contact, project: r.project },
    ip: r.ip, inputs: JSON.parse(r.inputs), results: JSON.parse(r.results)
  };
}

function createPgStore(connectionString) {
  const sql = neon(connectionString);
  const q = (text, params) => sql.query(text, params || []);

  return {
    kind: "postgres",
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        name TEXT NOT NULL, org TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL, inputs TEXT NOT NULL, results TEXT NOT NULL, consent BOOLEAN NOT NULL DEFAULT TRUE
      )`);
      await q("CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC)");
      await q("CREATE TABLE IF NOT EXISTS rate_events (key TEXT NOT NULL, ts BIGINT NOT NULL)");
      await q("CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_events (key, ts)");
    },
    async insertReport(e) {
      await q("INSERT INTO reports (id, created_at, name, org, contact, project, ip, inputs, results) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [e.id, e.at, e.user.name, e.user.org, e.user.contact, e.user.project, e.ip, JSON.stringify(e.inputs), JSON.stringify(e.results)]);
    },
    async queryReports(search, limit, offset) {
      let where = "", params = [];
      if (search) {
        const like = "%" + escapeLike(search) + "%";
        where = " WHERE name ILIKE $1 OR org ILIKE $1 OR project ILIKE $1 OR ip ILIKE $1";
        params = [like];
      }
      const total = Number((await q("SELECT COUNT(*)::int AS n FROM reports" + where, params))[0].n);
      const order = " ORDER BY created_at DESC, id DESC";
      const rows = limit == null
        ? await q("SELECT * FROM reports" + where + order, params)
        : await q("SELECT * FROM reports" + where + order + ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
      return { total, items: rows.map(rowToEntry) };
    },
    async allCount() { return Number((await q("SELECT COUNT(*)::int AS n FROM reports"))[0].n); },
    async deleteReport(id) { return (await q("DELETE FROM reports WHERE id = $1 RETURNING id", [id])).length > 0; },
    async deleteAll() { return (await q("DELETE FROM reports RETURNING id")).length; },
    async purgeOld(cutoffIso) { return (await q("DELETE FROM reports WHERE created_at < $1 RETURNING id", [cutoffIso])).length; },

    async rateCount(key, windowMs) {
      return Number((await q("SELECT COUNT(*)::int AS n FROM rate_events WHERE key = $1 AND ts > $2", [key, Date.now() - windowMs]))[0].n);
    },
    async rateAdd(key) {
      await q("INSERT INTO rate_events (key, ts) VALUES ($1, $2)", [key, Date.now()]);
      if (Math.random() < 0.05) await q("DELETE FROM rate_events WHERE ts < $1", [Date.now() - 3600000]);
    },
    async rateClear(key) { await q("DELETE FROM rate_events WHERE key = $1", [key]); },
    close() { /* HTTP 방식이라 닫을 연결 없음 */ }
  };
}

module.exports = { createPgStore };
