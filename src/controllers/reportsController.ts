import { Request, Response } from 'express';
import { query } from '../config/database';

// Every DATE(created_at) / GROUP BY DATE(created_at) / EXTRACT(HOUR FROM
// created_at) below relies on config/database.ts pinning every DB session to
// Africa/Nairobi. created_at columns are naive TIMESTAMPs, so
// CURRENT_TIMESTAMP writes them using whatever timezone the session happens
// to be in — DATE()/EXTRACT() themselves have no timezone awareness at all,
// they just read the literal stored value. Without that pin (verified: a
// UTC-default session wrote an order placed at 00:33 Nairobi time as 21:33
// the PREVIOUS day), every report here — including the Dashboard's Today's
// Sales and the hourly Sales Trend chart — would misattribute anything near
// midnight to the wrong calendar day or hour.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function computeSummary(startDate: string, endDate: string) {
  const salesRes = await query(`
    SELECT
      COALESCE(SUM(total), 0) as total_sales,
      COUNT(*) as total_orders,
      COALESCE(AVG(total), 0) as avg_order_value,
      COALESCE(SUM(discount), 0) as total_discounts,
      COALESCE(SUM(total) - SUM(discount), 0) as net_sales
    FROM orders
    WHERE DATE(created_at) BETWEEN $1 AND $2 AND status = 'completed'
  `, [startDate, endDate]);

  const cogsRes = await query(`
    SELECT COALESCE(SUM(oi.quantity * mi.cost), 0) as cogs
    FROM order_items oi
    JOIN menu_items mi ON oi.menu_item_id = mi.id
    JOIN orders o ON oi.order_id = o.id
    WHERE DATE(o.created_at) BETWEEN $1 AND $2 AND o.status = 'completed'
  `, [startDate, endDate]);

  // Real operating expenses for the same window — rent, utilities, supplies
  // bought outside a tracked purchase order, anything logged on the
  // Expenses page. Gross profit alone (revenue minus recipe cost) was the
  // only profit figure this system ever produced; it answers "did the food
  // itself make money" but not "did the business make money", which needs
  // these subtracted too. expense_date (not created_at) is the column that
  // actually means "when this expense happened", matching how the Expenses
  // page itself already filters.
  const expensesRes = await query(`
    SELECT COALESCE(SUM(amount), 0) as total_expenses
    FROM expenses
    WHERE expense_date BETWEEN $1 AND $2
  `, [startDate, endDate]);

  const stats = salesRes.rows[0];
  const cogs = parseFloat(cogsRes.rows[0].cogs);
  const net_sales = parseFloat(stats.net_sales);
  const gross_profit = net_sales - cogs;
  const total_expenses = parseFloat(expensesRes.rows[0].total_expenses);
  const net_profit = gross_profit - total_expenses;

  return {
    total_sales: parseFloat(stats.total_sales),
    total_orders: parseInt(stats.total_orders),
    avg_order_value: parseFloat(stats.avg_order_value),
    total_discounts: parseFloat(stats.total_discounts),
    net_sales,
    cogs,
    gross_profit,
    gross_profit_margin: net_sales > 0 ? Math.round((gross_profit / net_sales) * 100) : 0,
    total_expenses,
    net_profit,
    net_profit_margin: net_sales > 0 ? Math.round((net_profit / net_sales) * 100) : 0,
  };
}

// Shifts a [startDate, endDate] range back by its own length to get the
// immediately-preceding period of equal size — a week compares to the week
// before, a month to the month before, a single day to the day before. This
// is what makes the "+18% vs yesterday" style trend numbers real instead of
// the hardcoded figures every KPI card used to show regardless of actual
// performance.
function previousPeriod(startDate: string, endDate: string): [string, string] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * 86400000);
  const toStr = (d: Date) => d.toISOString().slice(0, 10);
  return [toStr(prevStart), toStr(prevEnd)];
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0; // null = "no baseline to compare against", shown as "—" not a fake 0%/∞%
  return Math.round(((current - previous) / previous) * 100);
}

// Single endpoint for Daily/Weekly/Monthly alike — the frontend computes the
// actual [start_date, end_date] for whichever tab is selected and this
// returns the same rich shape (summary, category/payment breakdowns, top
// items, a trend series, and a real comparison against the equivalent prior
// period) regardless of range length. Before this, Weekly and Monthly were
// separate endpoints returning a much thinner shape that the frontend never
// actually called — clicking those tabs just silently re-fetched the same
// daily data over again.
export const getSummaryReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const { start_date, end_date } = req.query;
    const startDate = String(start_date || '');
    const endDate = String(end_date || startDate);

    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
      res.status(400).json({ success: false, message: 'start_date and end_date must be in YYYY-MM-DD format' });
      return;
    }
    if (endDate < startDate) {
      res.status(400).json({ success: false, message: 'end_date must not be before start_date' });
      return;
    }

    const summary = await computeSummary(startDate, endDate);
    const [prevStart, prevEnd] = previousPeriod(startDate, endDate);
    const prevSummary = await computeSummary(prevStart, prevEnd);

    const categoryRes = await query(`
      SELECT mc.name as category, SUM(oi.total_price) as sales, COUNT(oi.id) as qty
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      JOIN menu_categories mc ON mi.category_id = mc.id
      JOIN orders o ON oi.order_id = o.id
      WHERE DATE(o.created_at) BETWEEN $1 AND $2 AND o.status = 'completed'
      GROUP BY mc.name ORDER BY sales DESC
    `, [startDate, endDate]);

    const paymentRes = await query(`
      SELECT payment_method, SUM(amount) as amount, COUNT(*) as count
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      WHERE DATE(o.created_at) BETWEEN $1 AND $2 AND p.status = 'completed'
      GROUP BY payment_method
    `, [startDate, endDate]);

    const topItemsRes = await query(`
      SELECT oi.item_name, SUM(oi.quantity) as qty_sold, SUM(oi.total_price) as sales,
        mi.cost, mi.image_url, SUM(oi.quantity * mi.cost) as total_cost,
        CASE WHEN SUM(oi.total_price) > 0 THEN ROUND(((SUM(oi.total_price) - SUM(oi.quantity * mi.cost)) / SUM(oi.total_price) * 100)::numeric, 0) ELSE 0 END as profit_margin
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      JOIN orders o ON oi.order_id = o.id
      WHERE DATE(o.created_at) BETWEEN $1 AND $2 AND o.status = 'completed'
      GROUP BY oi.item_name, mi.cost, mi.image_url
      ORDER BY sales DESC LIMIT 10
    `, [startDate, endDate]);

    // A single day gets an hourly trend (as before); anything longer gets a
    // daily trend instead — 30-odd hourly bars for a month would be an
    // unreadable wall of noise, and a single-day view has no days to bucket
    // by in the first place.
    const isSingleDay = startDate === endDate;
    let trend: Array<{ label: string; sales: number; orders: number }>;
    if (isSingleDay) {
      const hourlyRes = await query(`
        SELECT EXTRACT(HOUR FROM created_at) as hour, SUM(total) as sales, COUNT(*) as orders
        FROM orders
        WHERE DATE(created_at) = $1 AND status = 'completed'
        GROUP BY EXTRACT(HOUR FROM created_at)
        ORDER BY hour
      `, [startDate]);
      trend = hourlyRes.rows.map(r => ({ label: String(parseInt(r.hour)).padStart(2, '0') + ':00', sales: parseFloat(r.sales) || 0, orders: parseInt(r.orders) || 0 }));
    } else {
      const dailyRes = await query(`
        SELECT DATE(created_at) as day, SUM(total) as sales, COUNT(*) as orders
        FROM orders
        WHERE DATE(created_at) BETWEEN $1 AND $2 AND status = 'completed'
        GROUP BY DATE(created_at) ORDER BY day
      `, [startDate, endDate]);
      trend = dailyRes.rows.map(r => ({ label: new Date(r.day).toISOString().slice(5, 10), sales: parseFloat(r.sales) || 0, orders: parseInt(r.orders) || 0 }));
    }

    res.json({
      success: true,
      data: {
        summary,
        comparison: {
          total_sales_change_pct: pctChange(summary.total_sales, prevSummary.total_sales),
          total_orders_change_pct: pctChange(summary.total_orders, prevSummary.total_orders),
          avg_order_value_change_pct: pctChange(summary.avg_order_value, prevSummary.avg_order_value),
          gross_profit_change_pct: pctChange(summary.gross_profit, prevSummary.gross_profit),
          net_profit_change_pct: pctChange(summary.net_profit, prevSummary.net_profit),
        },
        by_category: categoryRes.rows.map(r => ({ category: r.category, sales: parseFloat(r.sales) || 0, qty: parseInt(r.qty) || 0 })),
        by_payment: paymentRes.rows.map(r => ({ payment_method: r.payment_method, amount: parseFloat(r.amount) || 0, count: parseInt(r.count) || 0 })),
        top_items: topItemsRes.rows.map(r => ({
          item_name: r.item_name, qty_sold: parseInt(r.qty_sold) || 0, sales: parseFloat(r.sales) || 0,
          cost: parseFloat(r.cost) || 0, total_cost: parseFloat(r.total_cost) || 0, profit_margin: parseFloat(r.profit_margin) || 0,
          image_url: r.image_url || null,
        })),
        trend,
        trend_granularity: isSingleDay ? 'hourly' : 'daily',
        // Kept for the Dashboard page, which reads rep.hourly directly with
        // an {hour, sales, orders} shape — only meaningful for a single-day
        // range, which is the only way Dashboard ever calls this.
        ...(isSingleDay ? { hourly: trend.map(t => ({ hour: parseInt(t.label), sales: t.sales, orders: t.orders })) } : {}),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Legacy single-date route (Dashboard's "Today's Sales" widget, and anything
// else that just wants one day) — delegates to the range-based
// implementation above with start=end=date, so there's exactly one query
// path for "sales in this period" rather than two that could drift apart.
export const getDailyReport = async (req: Request, res: Response): Promise<void> => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  req.query = { start_date: date, end_date: date };
  return getSummaryReport(req, res);
};