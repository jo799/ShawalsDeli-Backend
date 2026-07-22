import { Request, Response } from 'express';
import ExcelJS from 'exceljs';
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

// GET /reports/financial-summary-export?period=today|week|month|year  (or start_date=&end_date=)
//
// A real .xlsx workbook covering how expenses and purchases actually
// connect to profitability — the thing missing before was that Purchases
// and Expenses were each just their own itemized list with no way to see
// how they add up against what was actually sold. Three sheets: the
// headline Financial Summary (reusing computeSummary directly rather than
// recomputing the same numbers a second time, so this can never drift from
// what Reports itself shows), then itemized Expenses and Purchases detail
// for the same period.
export const exportFinancialSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const { period, start_date, end_date } = req.query as { period?: string; start_date?: string; end_date?: string };

    let startDate: string; let endDate: string; let periodLabel: string;
    if (start_date && end_date) {
      startDate = start_date; endDate = end_date;
      periodLabel = `${start_date} to ${end_date}`;
    } else {
      const p = period === 'week' || period === 'month' || period === 'year' ? period : 'day';
      const rangeRes = await query(`SELECT DATE_TRUNC('${p}', CURRENT_TIMESTAMP)::date as start_d, CURRENT_DATE as end_d`);
      startDate = rangeRes.rows[0].start_d.toISOString().slice(0, 10);
      endDate = rangeRes.rows[0].end_d.toISOString().slice(0, 10);
      periodLabel = { day: 'Today', week: 'This Week', month: 'This Month', year: 'This Year' }[p]!;
    }

    const summary = await computeSummary(startDate, endDate);

    const purchasesRes = await query(`
      SELECT po.po_number, po.order_date, po.status, po.total_amount, s.name as supplier_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      WHERE po.order_date BETWEEN $1 AND $2
      ORDER BY po.order_date DESC
    `, [startDate, endDate]);
    const totalPurchasesSpend = purchasesRes.rows.reduce((sum, r) => sum + Number(r.total_amount), 0);

    const expensesRes = await query(`
      SELECT e.title, ec.name as category_name, e.vendor, e.expense_date, e.payment_method, e.amount
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      WHERE e.expense_date BETWEEN $1 AND $2
      ORDER BY e.expense_date DESC
    `, [startDate, endDate]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Shawal's Deli POS";
    workbook.created = new Date();

    // ── Sheet 1: Financial Summary ──────────────────────────────────────
    const summarySheet = workbook.addWorksheet('Financial Summary');
    summarySheet.columns = [{ header: 'Metric', key: 'metric', width: 32 }, { header: 'Value', key: 'value', width: 20 }];
    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3A712' } };
    summarySheet.addRow({ metric: `Period: ${periodLabel} (${startDate} to ${endDate})`, value: '' });
    summarySheet.addRow({});
    const summaryRows = [
      ['Total Sales', summary.total_sales],
      ['Discounts', -summary.total_discounts],
      ['Net Sales', summary.net_sales],
      ['Cost of Goods Sold (COGS)', -summary.cogs],
      ['Gross Profit', summary.gross_profit],
      ['Gross Profit Margin', `${summary.gross_profit_margin}%`],
      ['Total Operating Expenses', -summary.total_expenses],
      ['Net Profit', summary.net_profit],
      ['Net Profit Margin', `${summary.net_profit_margin}%`],
      [],
      ['Total Purchases Spend (stock bought this period)', totalPurchasesSpend],
    ];
    summaryRows.forEach(row => {
      if (row.length === 0) { summarySheet.addRow({}); return; }
      const [metric, value] = row;
      const r = summarySheet.addRow({ metric, value: typeof value === 'number' ? value : value });
      if (typeof value === 'number') r.getCell('value').numFmt = '#,##0.00';
      if (metric === 'Net Profit' || metric === 'Gross Profit') r.font = { bold: true };
    });

    // ── Sheet 2: Expenses Detail ─────────────────────────────────────────
    const expSheet = workbook.addWorksheet('Expenses Detail');
    expSheet.columns = [
      { header: 'Date', key: 'date', width: 12 }, { header: 'Title', key: 'title', width: 28 },
      { header: 'Category', key: 'category', width: 18 }, { header: 'Vendor', key: 'vendor', width: 20 },
      { header: 'Payment Method', key: 'payment_method', width: 16 }, { header: 'Amount (KES)', key: 'amount', width: 14 },
    ];
    expSheet.getRow(1).font = { bold: true };
    expSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3A712' } };
    expensesRes.rows.forEach(e => expSheet.addRow({
      date: new Date(e.expense_date).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }),
      title: e.title, category: e.category_name || '—', vendor: e.vendor || '—',
      payment_method: e.payment_method ? e.payment_method.toUpperCase() : '—', amount: Number(e.amount),
    }));
    expSheet.getColumn('amount').numFmt = '#,##0.00';
    if (expensesRes.rows.length > 0) {
      const t = expSheet.addRow({ title: 'TOTAL', amount: summary.total_expenses });
      t.font = { bold: true }; t.getCell('amount').numFmt = '#,##0.00'; t.border = { top: { style: 'thin' } };
    }

    // ── Sheet 3: Purchases Detail ────────────────────────────────────────
    const poSheet = workbook.addWorksheet('Purchases Detail');
    poSheet.columns = [
      { header: 'Date', key: 'date', width: 12 }, { header: 'PO Number', key: 'po_number', width: 18 },
      { header: 'Supplier', key: 'supplier', width: 24 }, { header: 'Status', key: 'status', width: 14 },
      { header: 'Total (KES)', key: 'total', width: 14 },
    ];
    poSheet.getRow(1).font = { bold: true };
    poSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3A712' } };
    purchasesRes.rows.forEach(p => poSheet.addRow({
      date: new Date(p.order_date).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }),
      po_number: p.po_number, supplier: p.supplier_name || '—',
      status: (p.status as string).replace('_', ' '), total: Number(p.total_amount),
    }));
    poSheet.getColumn('total').numFmt = '#,##0.00';
    if (purchasesRes.rows.length > 0) {
      const t = poSheet.addRow({ po_number: 'TOTAL', total: totalPurchasesSpend });
      t.font = { bold: true }; t.getCell('total').numFmt = '#,##0.00'; t.border = { top: { style: 'thin' } };
    }

    const safeLabel = periodLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="financial-summary-${safeLabel}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Financial summary export error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /reports/owner-dashboard
//
// The 10 numbers an owner needs to read the health of the whole business
// in about 30 seconds. Several of these already existed elsewhere in the
// app but were never actually surfaced on the Dashboard (inventory value,
// month-scoped expenses); a few needed genuinely new logic that didn't
// exist anywhere (cash position, waste cost, and — importantly — the
// EXISTING "top items" list is sorted by revenue, not profit, so the
// highest earner and the most profitable dish are not necessarily the
// same thing; a lower-margin item that sells in volume can out-earn a
// high-margin item that rarely sells, but contribute less actual profit).
//
// Scope: revenue/profit/food-cost figures are TODAY (matching the
// dashboard's existing daily focus and computeSummary). Purchases,
// expenses, waste, and top item are THIS MONTH — a single day is too
// sparse a sample for "what's our most profitable dish" or "how much are
// we spending on stock" to mean much; a month gives a stable, trustworthy
// answer instead. Inventory value has no time scope at all — it's a
// snapshot of what's on the shelf right now, not a period total.
export const getOwnerDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const summary = await computeSummary(today, today);
    const foodCostPct = summary.net_sales > 0 ? Math.round((summary.cogs / summary.net_sales) * 100) : 0;

    // Cash position — real money collected today (every payment method
    // except 'points', which isn't actual cash) minus what actually left
    // the business today: today's expenses (an expense row IS the paid
    // record — there's no separate "paid" flag, logging one means it
    // happened) and any purchase order paid in full today. A partially
    // paid PO is deliberately excluded rather than guessed at — there's no
    // amount-paid field on purchase_orders, only a status, so there's no
    // reliable partial figure to subtract; counting the FULL total for a
    // partial payment would overstate what actually left the till.
    const cashInRes = await query(`
      SELECT COALESCE(SUM(p.amount), 0) as cash_in
      FROM payments p JOIN orders o ON p.order_id = o.id
      WHERE DATE(o.created_at) = $1 AND p.status = 'completed' AND p.payment_method != 'points'
    `, [today]);
    const paidPurchasesRes = await query(`
      SELECT COALESCE(SUM(total_amount), 0) as total FROM purchase_orders
      WHERE order_date = $1 AND payment_status = 'paid'
    `, [today]);
    const cashPosition = parseFloat(cashInRes.rows[0].cash_in) - summary.total_expenses - parseFloat(paidPurchasesRes.rows[0].total);

    // Inventory value — same calculation getInventory's own stats already
    // use, just never read by the Dashboard.
    const invValueRes = await query(`SELECT COALESCE(SUM(quantity * cost_per_unit), 0) as total_value FROM inventory_items WHERE is_active = true`);

    const purchasesMonthRes = await query(`
      SELECT COALESCE(SUM(total_amount), 0) as total FROM purchase_orders
      WHERE DATE_TRUNC('month', order_date) = DATE_TRUNC('month', CURRENT_DATE) AND status != 'cancelled'
    `);

    const expensesPeriod = req.query.expenses_period === 'today' ? 'day'
      : req.query.expenses_period === 'week' ? 'week'
      : 'month';
    const expensesMonthRes = await query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses
      WHERE expense_date >= DATE_TRUNC('${expensesPeriod}', CURRENT_TIMESTAMP)::date AND expense_date <= CURRENT_DATE
    `);

    // Waste cost — the current cost_per_unit is the best available figure
    // for what a wasted quantity was worth; inventory_transactions doesn't
    // snapshot cost at the time of the transaction (the same limitation
    // COGS already has via menu_items.cost, not a new one introduced here).
    const wasteRes = await query(`
      SELECT COALESCE(SUM(ABS(it.quantity_change) * ii.cost_per_unit), 0) as waste_cost
      FROM inventory_transactions it JOIN inventory_items ii ON it.inventory_item_id = ii.id
      WHERE it.type = 'waste' AND DATE_TRUNC('month', it.created_at) = DATE_TRUNC('month', CURRENT_DATE)
    `);

    // Top profitable item — deliberately sorted by absolute profit
    // (revenue minus recipe cost), not revenue and not margin percentage.
    // A 90%-margin item sold twice contributes less real profit than a
    // 30%-margin item sold two hundred times; this is the one that
    // actually made the business the most money this month.
    const topItemRes = await query(`
      SELECT oi.item_name,
        SUM(oi.total_price) as sales,
        SUM(oi.quantity * mi.cost) as total_cost,
        SUM(oi.total_price) - SUM(oi.quantity * mi.cost) as profit
      FROM order_items oi
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      JOIN orders o ON oi.order_id = o.id
      WHERE DATE_TRUNC('month', o.created_at) = DATE_TRUNC('month', CURRENT_DATE) AND o.status = 'completed'
      GROUP BY oi.item_name
      ORDER BY profit DESC
      LIMIT 1
    `);

    res.json({
      success: true,
      data: {
        revenue_today: summary.total_sales,
        gross_profit_today: summary.gross_profit,
        net_profit_today: summary.net_profit,
        cash_position_today: cashPosition,
        inventory_value: parseFloat(invValueRes.rows[0].total_value),
        purchases_this_month: parseFloat(purchasesMonthRes.rows[0].total),
        expenses: parseFloat(expensesMonthRes.rows[0].total),
        expenses_period_label: { day: 'today', week: 'this week', month: 'this month' }[expensesPeriod],
        food_cost_pct: foodCostPct,
        waste_cost_this_month: parseFloat(wasteRes.rows[0].waste_cost),
        top_profitable_item: topItemRes.rows[0] ? {
          name: topItemRes.rows[0].item_name,
          profit: parseFloat(topItemRes.rows[0].profit),
          sales: parseFloat(topItemRes.rows[0].sales),
        } : null,
      },
    });
  } catch (error) {
    console.error('Owner dashboard error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};