import { Pool, PoolConfig, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// node-postgres's default parser for "timestamp without time zone" (OID
// 1114) treats the naive string it gets back as if it were already UTC.
// But every TIMESTAMP column in this schema actually holds Africa/Nairobi
// wall-clock time (see SET TIME ZONE below) — so the default parser
// silently mislabels a value like "20:18" (correct Nairobi time) as
// "20:18 UTC", and the browser then correctly converts *that* to Nairobi
// local time by adding 3 more hours, landing on 23:18. The fix: parse the
// naive components ourselves and subtract Nairobi's fixed +3 offset (no
// DST in East Africa Time, so this is always exactly 3) before building
// the Date, giving the correct UTC instant on the first pass instead of
// double-applying the offset.
types.setTypeParser(1114, (value: string) => {
  const [datePart, timePart] = value.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hms, fractional] = (timePart || '00:00:00').split('.');
  const [hour, minute, second] = hms.split(':').map(Number);
  const ms = fractional ? Number(fractional.padEnd(3, '0').slice(0, 3)) : 0;
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, second, ms));
});

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