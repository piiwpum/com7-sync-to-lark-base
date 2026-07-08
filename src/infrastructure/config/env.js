import 'dotenv/config';

const num = (v, d) => (v == null || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  // MySQL instance A — Com7 source (READ-ONLY, one-way; never written to)
  com7Db: {
    host: process.env.COM7_DB_HOST ?? 'localhost',
    port: num(process.env.COM7_DB_PORT, 3306),
    user: process.env.COM7_DB_USER ?? 'readonly',
    password: process.env.COM7_DB_PASSWORD ?? '',
    database: process.env.COM7_DB_NAME ?? 'com7',
  },

  // MySQL instance B — ops store: mapping / pointer / state / job_queue (§6)
  opsDb: {
    host: process.env.OPS_DB_HOST ?? 'localhost',
    port: num(process.env.OPS_DB_PORT, 3306),
    user: process.env.OPS_DB_USER ?? 'sync',
    password: process.env.OPS_DB_PASSWORD ?? '',
    database: process.env.OPS_DB_NAME ?? 'sync_ops',
  },

  // LarkBase API. App credentials are NOT stored here — they arrive per-request
  // via headers (X-Lark-App-Id / X-Lark-App-Secret). Only the domain is config.
  lark: {
    baseDomain: process.env.LARK_BASE_DOMAIN ?? 'https://open.larksuite.com',
  },

  // POST /base/init soft time budget per call (ms) before it returns partial.
  baseInit: {
    budgetMs: num(process.env.BASE_INIT_BUDGET_MS, 600000),
  },

  // POST /sync/incremental (flow B+C, UTime watermark).
  incremental: {
    // Watermark seed when sync_state['incremental'] is empty (never run).
    // Prod = the date this service was deployed at Com7; nothing before it
    // was ever meant to reach Lark. CE, Asia/Bangkok wall clock. Mock = 3 Jul 2026.
    defaultSince: process.env.INCREMENTAL_DEFAULT_SINCE ?? '2026-07-03 00:00:00',
    // Rows pulled per call; also the soft cap that makes a call resumable
    // (watermark advances to what was processed; next call continues).
    chunkSize: num(process.env.INCREMENTAL_CHUNK_SIZE, 1000),
  },
};
