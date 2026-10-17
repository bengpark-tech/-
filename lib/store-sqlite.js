"use strict";
/* 로컬 실행용 저장소(SQLite 파일). Node.js 22.13+ 내장 node:sqlite 사용 */
const fs = require("node:fs");
const path = require("node:path");

function escapeLike(s) { return s.replace(/[\\%_]/g, c => "\\" + c); }
function rowToEntry(r) {
  return {
    id: r.id, at: r.created_at,
    user: { name: r.name, org: r.org, contact: r.contact, project: r.project },
    ip: r.ip, inputs: JSON.parse(r.inputs), results: JSON.parse(r.results)
  };
}

function createSqliteStore(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  let insert, del, delAll, purge;

  return {
    kind: "sqlite",
    path: dbPath,
    async init() {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS reports (
          id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
          name TEXT NOT NULL, org TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
          ip TEXT NOT NULL, inputs TEXT NOT NULL, results TEXT NOT NULL, consent INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);
        CREATE TABLE IF NOT EXISTS rate_events (key TEXT NOT NULL, ts INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_events (key, ts);
      `);
      insert = db.prepare("INSERT INTO reports (id, created_at, name, org, contact, project, ip, inputs, results, consent) VALUES (?,?,?,?,?,?,?,?,?,1)");
      del = db.prepare("DELETE FROM reports WHERE id = ?");
      delAll = db.prepare("DELETE FROM reports");
      purge = db.prepare("DELETE FROM reports WHERE created_at < ?");
    },
    async insertReport(e) {
      insert.run(e.id, e.at, e.user.name, e.user.org, e.user.contact, e.user.project, e.ip, JSON.stringify(e.inputs), JSON.stringify(e.results));
    },
    async queryReports(q, limit, offset) {
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
      return { total, items: rows.map(rowToEntry) };
    },
    async allCount() { return db.prepare("SELECT COUNT(*) AS n FROM reports").get().n; },
    async deleteReport(id) { return Number(del.run(id).changes) > 0; },
    async deleteAll() { return Number(delAll.run().changes); },
    async purgeOld(cutoffIso) { return Number(purge.run(cutoffIso).changes); },

    async rateCount(key, windowMs) {
      return db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND ts > ?").get(key, Date.now() - windowMs).n;
    },
    async rateAdd(key) {
      db.prepare("INSERT INTO rate_events (key, ts) VALUES (?, ?)").run(key, Date.now());
      if (Math.random() < 0.05) db.prepare("DELETE FROM rate_events WHERE ts < ?").run(Date.now() - 3600000);
    },
    async rateClear(key) { db.prepare("DELETE FROM rate_events WHERE key = ?").run(key); },
    close() { try { db.close(); } catch (e) { /* noop */ } }
  };
}

module.exports = { createSqliteStore };
