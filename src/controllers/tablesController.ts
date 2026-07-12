import { Request, Response } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { logAudit } from '../services/auditLog';

export const getTables = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT t.*, o.order_number, o.total as order_total, o.amount_paid as order_amount_paid,
        o.status as order_status, o.created_at as order_started,
        c.full_name as customer_name, c.phone as customer_phone,
        EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - o.created_at))/60 as minutes_occupied
      FROM restaurant_tables t
      LEFT JOIN orders o ON t.current_order_id = o.id
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE t.is_active = true
      ORDER BY t.area, t.table_number
    `);
    const stats = await query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'occupied') as occupied,
        COUNT(*) FILTER (WHERE status = 'available') as available,
        COUNT(*) FILTER (WHERE status = 'reserved') as reserved,
        COUNT(*) FILTER (WHERE status = 'cleaning') as cleaning
      FROM restaurant_tables
      WHERE is_active = true
    `);
    // COUNT(*) comes back as a string (bigint) from node-postgres — parse so
    // these are real numbers for any caller that does arithmetic on them.
    const s = stats.rows[0];
    res.json({
      success: true, data: result.rows,
      stats: { total: +s.total, occupied: +s.occupied, available: +s.available, reserved: +s.reserved, cleaning: +s.cleaning },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// ─── Table CRUD (add/remove tables from the floor plan) ───────────────────
// Distinct from updateTableStatus below, which handles the LIVE
// available/occupied/reserved/cleaning workflow. This is restaurant
// configuration — adding a new table, fixing a typo'd number, retiring one
// — restricted to admin/manager the same way menu management is (see
// routes/index.ts).

export const createTable = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { table_number, area, capacity } = req.body;
    if (!table_number || !String(table_number).trim()) {
      res.status(400).json({ success: false, message: 'table_number is required' });
      return;
    }
    const cap = capacity === undefined ? 2 : Number(capacity);
    if (!Number.isInteger(cap) || cap < 1) {
      res.status(400).json({ success: false, message: 'capacity must be a whole number of at least 1' });
      return;
    }
    const result = await query(
      `INSERT INTO restaurant_tables (table_number, area, capacity, status, is_active)
       VALUES ($1, $2, $3, 'available', true) RETURNING *`,
      [String(table_number).trim(), area || 'Main Hall', cap]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: unknown) {
    // table_number has a UNIQUE constraint — surface that as a clean 400
    // instead of a generic 500. This also catches the case where a table
    // number matches one that's only soft-deleted (is_active=false); the
    // constraint doesn't know about is_active, so re-adding a retired
    // table's number currently means renaming it slightly — acceptable
    // for now rather than adding restore-a-deleted-table complexity.
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') {
      res.status(400).json({ success: false, message: 'A table with that number already exists' });
      return;
    }
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateTable = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { table_number, area, capacity } = req.body;
    if (!table_number || !String(table_number).trim()) {
      res.status(400).json({ success: false, message: 'table_number is required' });
      return;
    }
    const cap = capacity === undefined ? undefined : Number(capacity);
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
      res.status(400).json({ success: false, message: 'capacity must be a whole number of at least 1' });
      return;
    }
    const result = await query(
      `UPDATE restaurant_tables SET table_number = $1, area = $2, capacity = COALESCE($3, capacity), updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND is_active = true RETURNING *`,
      [String(table_number).trim(), area || 'Main Hall', cap ?? null, id]
    );
    if (result.rows.length === 0) { res.status(404).json({ success: false, message: 'Table not found' }); return; }
    res.json({ success: true, data: result.rows[0] });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === '23505') {
      res.status(400).json({ success: false, message: 'A table with that number already exists' });
      return;
    }
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deleteTable = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const existing = await query('SELECT status FROM restaurant_tables WHERE id = $1 AND is_active = true', [id]);
    if (existing.rows.length === 0) { res.status(404).json({ success: false, message: 'Table not found' }); return; }

    // Refuse to remove a table that's currently occupied — it should be
    // cleared (or its order resolved) first, the same protection that
    // already exists for the "Close Table" override. Reserved/cleaning
    // tables can still be removed (lower-stakes edge cases: an upcoming
    // reservation, a table being wiped down, not a seated party).
    if (existing.rows[0].status === 'occupied') {
      res.status(409).json({ success: false, message: 'This table is currently occupied. Clear it before removing it from the floor plan.' });
      return;
    }

    // Soft delete — see migrate.ts for why (keeps historical orders'
    // table_number resolvable via the FK join instead of losing it).
    await query(
      `UPDATE restaurant_tables SET is_active = false, current_order_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );
    await logAudit(req, { action: 'table_deleted', entityType: 'table', entityId: id });
    res.json({ success: true, message: 'Table removed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateTableStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['available', 'occupied', 'reserved', 'cleaning'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    // A manual status change (e.g. staff clearing a table by hand) is the
    // deliberate override for situations the automatic order-driven release
    // doesn't cover — a customer who left without staff completing the
    // order, a data mismatch, a walkout. If the table is being freed
    // ('available'/'cleaning'), warn when its linked order is still open
    // rather than silently leaving a dangling current_order_id pointing at
    // an order nobody resolved.
    let warning: string | undefined;
    if (status === 'available' || status === 'cleaning') {
      const linked = await query(
        `SELECT o.order_number, o.status, o.total, o.amount_paid FROM restaurant_tables t
         JOIN orders o ON o.id = t.current_order_id WHERE t.id = $1`,
        [id]
      );
      if (linked.rows.length > 0 && !['completed', 'cancelled'].includes(linked.rows[0].status)) {
        const balanceDue = Math.round((Number(linked.rows[0].total) - Number(linked.rows[0].amount_paid)) * 100) / 100;
        warning = balanceDue > 0.01
          ? `Order #${linked.rows[0].order_number} on this table is still open with KES ${balanceDue.toFixed(2)} unpaid — clearing the table does not cancel or settle it.`
          : `Order #${linked.rows[0].order_number} on this table is still open (not yet marked completed) — clearing the table does not close it out.`;
      }
    }

    const result = await query(`
      UPDATE restaurant_tables
      SET status = $1::VARCHAR,
          current_order_id = CASE WHEN $1::VARCHAR IN ('available','cleaning') THEN NULL ELSE current_order_id END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 RETURNING *
    `, [status, id]);
    if (!result.rows.length) { res.status(404).json({ success: false, message: 'Table not found' }); return; }
    res.json({ success: true, data: result.rows[0], ...(warning ? { warning } : {}) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getReservations = async (req: Request, res: Response): Promise<void> => {
  try {
    const { date, status, upcoming } = req.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    // Same explicit-timezone requirement as createReservation's isToday
    // check — DATE(timestamptz) converts using the DB session's timezone,
    // which isn't necessarily Africa/Nairobi, so a plain DATE() cast here
    // would suffer the identical day-boundary mismatch.
    if (date) { conditions.push(`(r.reservation_time AT TIME ZONE 'Africa/Nairobi')::date = $${idx++}::date`); params.push(date); }
    // "Upcoming" (used by the Tables page's "View All" toggle) means
    // anything from now onward that hasn't been cancelled/completed/no-show
    // — a host-stand view of what's still coming, not tied to a single day.
    if (upcoming === 'true') {
      conditions.push(`r.reservation_time >= CURRENT_TIMESTAMP`);
      conditions.push(`r.status IN ('confirmed','seated')`);
    }
    if (status) { conditions.push(`r.status = $${idx++}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(`
      SELECT r.*, t.table_number, c.full_name as customer_full_name
      FROM reservations r
      LEFT JOIN restaurant_tables t ON r.table_id = t.id
      LEFT JOIN customers c ON r.customer_id = c.id
      ${where}
      ORDER BY r.reservation_time
      LIMIT 50
    `, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Reservation lifecycle: confirmed -> seated -> completed, with cancelled /
// no_show as exits from confirmed (or, rarely, seated). Each transition
// carries the table-status side effect a host would expect, but is careful
// never to clobber a table that's moved on for an unrelated reason (e.g.
// already occupied by a walk-in, or already released by a real order
// completing) — the guard on each branch below is what keeps that safe.
export const updateReservationStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['confirmed', 'seated', 'completed', 'cancelled', 'no_show'];
    if (!validStatuses.includes(status)) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const resRow = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [id]);
    if (resRow.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ success: false, message: 'Reservation not found' });
      return;
    }
    const reservation = resRow.rows[0];

    const updated = await client.query(
      'UPDATE reservations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (reservation.table_id) {
      const tableRow = await client.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = $1 FOR UPDATE', [reservation.table_id]);
      const table = tableRow.rows[0];
      if (table) {
        if (status === 'seated' && (table.status === 'reserved' || table.status === 'available')) {
          // Guest has physically arrived — the floor plan should reflect
          // that immediately, even before an order is rung up at the POS.
          await client.query(`UPDATE restaurant_tables SET status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [reservation.table_id]);
        } else if ((status === 'cancelled' || status === 'no_show') && table.status === 'reserved') {
          // Only release if the table is still just 'reserved' (i.e.
          // nothing else has claimed it since) — if it somehow became
          // occupied by an unrelated walk-in in the meantime, leave it alone.
          await client.query(`UPDATE restaurant_tables SET status = 'available', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [reservation.table_id]);
        } else if (status === 'completed' && table.status === 'occupied' && !table.current_order_id) {
          // The party is done and there's no real order tracking this table
          // (if there were, that order's own completion is what should free
          // it — see ordersController — not this reservation record).
          await client.query(`UPDATE restaurant_tables SET status = 'available', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [reservation.table_id]);
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
};

export const createReservation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { table_id, customer_id, customer_name, customer_phone, guests, reservation_time, notes } = req.body;

    if (!table_id) {
      res.status(400).json({ success: false, message: 'table_id is required' });
      return;
    }
    if (!customer_name || !String(customer_name).trim()) {
      res.status(400).json({ success: false, message: 'customer_name is required' });
      return;
    }
    if (!reservation_time || isNaN(Date.parse(reservation_time))) {
      res.status(400).json({ success: false, message: 'reservation_time must be a valid date/time' });
      return;
    }
    const resTime = new Date(reservation_time);
    // 5-minute grace absorbs clock skew between browser and server rather
    // than rejecting a reservation someone is making for "right now".
    if (resTime.getTime() < Date.now() - 5 * 60 * 1000) {
      res.status(400).json({ success: false, message: 'Reservation time must be in the future' });
      return;
    }
    const guestCount = guests === undefined || guests === null ? 1 : Number(guests);
    if (!Number.isInteger(guestCount) || guestCount < 1) {
      res.status(400).json({ success: false, message: 'guests must be a whole number of at least 1' });
      return;
    }

    const tableCheck = await query('SELECT id, status FROM restaurant_tables WHERE id = $1 AND is_active = true', [table_id]);
    if (tableCheck.rows.length === 0) {
      res.status(404).json({ success: false, message: 'Table not found' });
      return;
    }

    const durationSetting = await query("SELECT value FROM settings WHERE key = 'default_reservation_duration_minutes'");
    const durationMinutes = parseInt(durationSetting.rows[0]?.value) || 90;

    const result = await query(`
      INSERT INTO reservations (table_id, customer_id, customer_name, customer_phone, guests, reservation_time, duration_minutes, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [table_id, customer_id || null, String(customer_name).trim(), customer_phone || null, guestCount, resTime, durationMinutes, notes || null, req.user!.id]);

    // Only flip the table's LIVE status if the reservation is for today and
    // the table is currently free. Without this check, booking a table for
    // next Tuesday would make it show "reserved" on the floor plan right
    // now — the table has no way to represent "free today, booked for
    // later" as a single status column, so the honest choice is to leave
    // today's status alone for anything not happening today. The
    // reservation itself is still recorded and will show up in the
    // Upcoming Reservations list for its actual date.
    //
    // This MUST be computed with an explicit timezone, not resTime.toDateString()
    // vs new Date().toDateString() — those format using the Node process's own
    // timezone, which is frequently NOT the restaurant's actual location
    // (e.g. UTC on most hosting, or a dev machine's shell environment). A
    // reservation near the day boundary would then land on the wrong side of
    // "today" depending on nothing more than what timezone the server
    // happened to be started in — exactly the bug that made this
    // inconsistent between different times of day. Postgres's AT TIME ZONE
    // gives a deterministic answer regardless of the server process's own
    // timezone setting.
    const todayCheck = await query(
      `SELECT ($1::timestamptz AT TIME ZONE 'Africa/Nairobi')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Nairobi')::date AS is_today`,
      [resTime]
    );
    const isToday = todayCheck.rows[0].is_today;
    if (isToday && tableCheck.rows[0].status === 'available') {
      await query(`UPDATE restaurant_tables SET status='reserved', updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [table_id]);
    }

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};