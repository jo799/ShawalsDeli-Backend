import { pool } from '../config/database';

const reset = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Drop all tables in correct order (respecting FK constraints)
    await client.query(`
      DROP TABLE IF EXISTS
        notifications, leave_requests, staff_schedules,
        loyalty_transactions, loyalty_rewards, loyalty_points, loyalty_tiers,
        reservations, payments, order_items, orders,
        purchase_order_items, purchase_orders,
        inventory_transactions, inventory_items,
        expenses, expense_categories,
        menu_item_modifiers, menu_modifier_options, menu_modifiers,
        menu_items, menu_categories,
        customers, suppliers, restaurant_tables, users
      CASCADE
    `);
    await client.query('COMMIT');
    console.log('✅ All tables dropped');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Reset failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

reset().then(() => process.exit(0)).catch(() => process.exit(1));
