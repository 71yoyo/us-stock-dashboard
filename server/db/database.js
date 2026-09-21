import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { environment } from "../config/environment.js";

let database;

/**
 * 금융 원본 데이터는 브라우저가 아닌 서버 SQLite에 보관한다.
 * data 폴더는 .gitignore에 포함되어 있어 가격·배당 캐시가 GitHub 이력에 쌓이지 않는다.
 */
export function getDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(environment.databasePath), { recursive: true });
  database = new DatabaseSync(environment.databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  createSchema(database);

  return database;
}

function createSchema(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      ticker TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sector TEXT,
      industry TEXT,
      exchange TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS price_quotes (
      ticker TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
      current_price REAL,
      previous_close REAL,
      change_amount REAL,
      change_percent REAL,
      market_updated_at TEXT,
      cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dividend_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
      declaration_date TEXT,
      ex_dividend_date TEXT,
      record_date TEXT,
      payment_date TEXT,
      amount REAL,
      frequency TEXT,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      source_updated_at TEXT,
      UNIQUE (ticker, ex_dividend_date, payment_date, amount)
    );

    CREATE TABLE IF NOT EXISTS financial_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,
      fiscal_period_end TEXT NOT NULL,
      revenue REAL,
      operating_income REAL,
      net_income REAL,
      eps REAL,
      free_cash_flow REAL,
      total_debt REAL,
      cash_and_equivalents REAL,
      cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (ticker, fiscal_period_end)
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_type TEXT NOT NULL,
      ticker TEXT,
      status TEXT NOT NULL,
      message TEXT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
  `);
}
