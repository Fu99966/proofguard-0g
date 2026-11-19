import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export function readRouterRequestsUsed(filename, scope) {
  if (!existsSync(filename)) return 0;
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const budgetTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'router_budgets'").get();
    if (!budgetTable) return 0;
    const used = db.prepare("SELECT reserved FROM router_budgets WHERE scope = ?").get(scope)?.reserved ?? 0;
    if (!Number.isSafeInteger(used) || used < 0) throw new Error("The persisted Router budget count is invalid.");
    return used;
  } finally {
    db.close();
  }
}

export function openReviewStore(filename) {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY,
      recorded_at INTEGER NOT NULL,
      transaction_hash TEXT NOT NULL,
      decision_record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS router_budgets (
      scope TEXT PRIMARY KEY,
      reserved INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permits (
      hash TEXT PRIMARY KEY,
      nonce TEXT NOT NULL UNIQUE,
      review_id INTEGER NOT NULL REFERENCES reviews(id),
      expires_at INTEGER NOT NULL,
      permit TEXT NOT NULL,
      consumed_at INTEGER
    );
  `);
  const insertReview = db.prepare("INSERT INTO reviews (recorded_at, transaction_hash, decision_record) VALUES (?, ?, ?)");
  const insertPermit = db.prepare("INSERT INTO permits (hash, nonce, review_id, expires_at, permit) VALUES (?, ?, ?, ?, ?)");
  const retrieve = db.prepare("SELECT permit, consumed_at FROM permits WHERE hash = ?");
  const audit = db.prepare(`SELECT r.recorded_at, r.transaction_hash, r.decision_record, p.consumed_at
    FROM permits p JOIN reviews r ON r.id = p.review_id WHERE p.hash = ?`);
  const reserve = db.prepare(`INSERT INTO router_budgets (scope, reserved) SELECT ?, ? WHERE ? <= ?
    ON CONFLICT (scope) DO UPDATE SET reserved = reserved + excluded.reserved WHERE reserved + excluded.reserved <= ?`);
  const consume = db.prepare("UPDATE permits SET consumed_at = ? WHERE hash = ? AND consumed_at IS NULL AND expires_at > ?");
  return {
    record: db.transaction((transactionHash, record, permit, now) => {
      const review = insertReview.run(now, transactionHash, JSON.stringify(record));
      if (permit) insertPermit.run(permit.permitHash, permit.nonce, review.lastInsertRowid, Date.parse(permit.expiresAt), JSON.stringify(permit));
    }),
    getPermit(hash) {
      const row = retrieve.get(hash);
      return row ? { permit: JSON.parse(row.permit), used: row.consumed_at !== null } : null;
    },
    getAudit(hash) {
      const row = audit.get(hash);
      return row ? { recordedAt: row.recorded_at, transactionHash: row.transaction_hash,
        consumedAt: row.consumed_at, ...JSON.parse(row.decision_record) } : null;
    },
    consume(hash, now) {
      return consume.run(now, hash, now).changes === 1;
    },
    reserveRouterRequests(scope, count, limit) {
      return reserve.run(scope, count, count, limit, limit).changes === 1;
    },
    close() {
      db.close();
    },
  };
}
