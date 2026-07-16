import { Response } from 'express';
import ExcelJS from 'exceljs';
import { AuthRequest } from '../middleware/auth';
import { query } from '../config/database';

// GET /reports/sales-export?period=today|week|month|year  (or start_date=&end_date=)
//
// A real .xlsx workbook, not a CSV — two sheets: a full line-item-level
// "Sales Detail" (one row per menu item sold, matching what was actually
// asked for: item, amount, time, who sold it) and a "Summary by Item"
// rollup, since a raw line-item dump alone doesn't answer "what sold best"
// at a glance, which is the question an owner opening this file is most
// likely actually asking.
//
// The date boundary is computed by Postgres itself (DATE_TRUNC on
// CURRENT_TIMESTAMP), not in application code — every connection in this
// app already runs with SET TIME ZONE 'Africa/Nairobi' (see
// config/database.ts), so "today"/"this week" here correctly means the
// restaurant's own local day/week, not whatever timezone the server
// process happens to be running in.
//
// "Sold" is defined as amount_paid > 0 — any order that has actually
// received money, regardless of its current kitchen status. An order still
// sitting in 'preparing' when this report runs is still a real sale; the
// cash is already in the till. This deliberately does NOT filter on
// status = 'completed', since that would silently exclude legitimate,
// already-paid sales for however long they're still being prepared.
export const exportSalesReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { period, start_date, end_date } = req.query as { period?: string; start_date?: string; end_date?: string };

    let dateFilter: string;
    let params: unknown[] = [];
    let periodLabel: string;

    if (start_date && end_date) {
      dateFilter = 'o.created_at >= $1 AND o.created_at < ($2::date + INTERVAL \'1 day\')';
      params = [start_date, end_date];
      periodLabel = `${start_date} to ${end_date}`;
    } else {
      const p = period === 'week' || period === 'month' || period === 'year' ? period : 'day';
      dateFilter = `o.created_at >= DATE_TRUNC('${p}', CURRENT_TIMESTAMP)`;
      periodLabel = { day: 'Today', week: 'This Week', month: 'This Month', year: 'This Year' }[p]!;
    }

    const result = await query(`
      SELECT
        oi.item_name, oi.quantity, oi.unit_price, oi.total_price,
        o.order_number, o.type as order_type, o.created_at,
        cat.name as category_name,
        u.full_name as sold_by,
        c.full_name as customer_name,
        t.table_number,
        (SELECT STRING_AGG(DISTINCT p.payment_method, ', ' ORDER BY p.payment_method)
         FROM payments p WHERE p.order_id = o.id AND p.status = 'completed') as payment_methods
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
      LEFT JOIN menu_categories cat ON mi.category_id = cat.id
      LEFT JOIN users u ON o.served_by = u.id
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE o.amount_paid > 0 AND ${dateFilter}
      ORDER BY o.created_at DESC
    `, params);

    const rows = result.rows;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Shawal's Deli POS";
    workbook.created = new Date();

    // ── Sheet 1: line-item detail ──────────────────────────────────────
    const detail = workbook.addWorksheet('Sales Detail');
    detail.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Time', key: 'time', width: 10 },
      { header: 'Order #', key: 'order_number', width: 16 },
      { header: 'Item', key: 'item_name', width: 28 },
      { header: 'Category', key: 'category', width: 16 },
      { header: 'Qty', key: 'quantity', width: 8 },
      { header: 'Unit Price (KES)', key: 'unit_price', width: 16 },
      { header: 'Amount (KES)', key: 'amount', width: 14 },
      { header: 'Order Type', key: 'order_type', width: 12 },
      { header: 'Table', key: 'table', width: 8 },
      { header: 'Customer', key: 'customer', width: 20 },
      { header: 'Payment Method', key: 'payment_method', width: 16 },
      { header: 'Sold By', key: 'sold_by', width: 20 },
    ];
    detail.getRow(1).font = { bold: true };
    detail.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3A712' } };
    detail.autoFilter = { from: 'A1', to: 'M1' };

    let grandTotal = 0;
    for (const r of rows) {
      const amount = Number(r.total_price);
      grandTotal += amount;
      detail.addRow({
        date: new Date(r.created_at).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' }),
        time: new Date(r.created_at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', hour12: true }),
        order_number: r.order_number,
        item_name: r.item_name,
        category: r.category_name || '—',
        quantity: Number(r.quantity),
        unit_price: Number(r.unit_price),
        amount,
        order_type: (r.order_type as string).replace('_', ' '),
        table: r.table_number || '—',
        customer: r.customer_name || 'Walk-in',
        payment_method: r.payment_methods ? (r.payment_methods as string).toUpperCase() : '—',
        sold_by: r.sold_by || '—',
      });
    }
    detail.getColumn('unit_price').numFmt = '#,##0.00';
    detail.getColumn('amount').numFmt = '#,##0.00';

    // Totals row, visually separated
    const totalsRow = detail.addRow({ item_name: 'TOTAL', amount: grandTotal });
    totalsRow.font = { bold: true };
    totalsRow.getCell('amount').numFmt = '#,##0.00';
    totalsRow.border = { top: { style: 'thin' } };

    // ── Sheet 2: summary by item — what actually sold best ─────────────
    const summaryMap = new Map<string, { category: string; qty: number; revenue: number }>();
    for (const r of rows) {
      const key = r.item_name as string;
      const existing = summaryMap.get(key) || { category: r.category_name || '—', qty: 0, revenue: 0 };
      existing.qty += Number(r.quantity);
      existing.revenue += Number(r.total_price);
      summaryMap.set(key, existing);
    }
    const summaryRows = Array.from(summaryMap.entries())
      .map(([item, v]) => ({ item, ...v }))
      .sort((a, b) => b.revenue - a.revenue);

    const summary = workbook.addWorksheet('Summary by Item');
    summary.columns = [
      { header: 'Item', key: 'item', width: 28 },
      { header: 'Category', key: 'category', width: 16 },
      { header: 'Total Qty Sold', key: 'qty', width: 15 },
      { header: 'Total Revenue (KES)', key: 'revenue', width: 18 },
    ];
    summary.getRow(1).font = { bold: true };
    summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3A712' } };
    summaryRows.forEach(r => summary.addRow(r));
    summary.getColumn('revenue').numFmt = '#,##0.00';
    if (summaryRows.length > 0) {
      const summaryTotal = summary.addRow({ item: 'TOTAL', revenue: grandTotal });
      summaryTotal.font = { bold: true };
      summaryTotal.getCell('revenue').numFmt = '#,##0.00';
      summaryTotal.border = { top: { style: 'thin' } };
    }

    const safeLabel = periodLabel.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="sales-report-${safeLabel}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Sales export error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};