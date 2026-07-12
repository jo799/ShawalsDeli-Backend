import { Pool, PoolConfig } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const config: PoolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'shawalsdeli',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

export const pool = new Pool(config);

// Every naive `TIMESTAMP` column in this schema (created_at, etc.) relies on
// CURRENT_TIMESTAMP/NOW() to fill itself in, and Postgres converts that
// (an absolute instant) down to a naive wall-clock value using the SESSION's
// timezone — which defaults to whatever the Postgres server itself was
// configured with (often UTC on managed hosting), not the restaurant's
// actual location. Without pinning this, `created_at` values silently drift
// by whatever the offset is, and every "today" comparison built on them
// (Dashboard's Today's Sales, Orders date filter, daily/weekly/monthly
// reports, reservations) can misattribute anything near the day boundary to
// the wrong calendar date. Pinning every connection to the business's actual
// timezone here fixes the write side for every table at once, rather than
// something that has to be remembered per-query.
const RESTAURANT_TIMEZONE = 'Africa/Nairobi';
pool.on('connect', (client) => {
  client.query(`SET TIME ZONE '${RESTAURANT_TIMEZONE}'`).catch((err) => {
    console.error('Failed to set session timezone on a new DB connection:', err);
  });
});

pool.on('connect', () => {
  console.log('✅ Database connected');
});

pool.on('error', (err) => {
  console.error('❌ Database error:', err);
  process.exit(-1);
});

export const query = async (text: string, params?: unknown[]) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.log('Query executed:', { text: text.substring(0, 80), duration, rows: res.rowCount });
  }
  return res;
};

export const getClient = () => pool.connect();