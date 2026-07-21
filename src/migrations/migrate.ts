import { pool } from '../config/database';

console.log("🚀 Migration script started");

const createTables = async () => {
  console.log("📡 Connecting to database...");
  const client = await pool.connect();
  console.log("✅ Connected to database.");
  
  try {
    await client.query('BEGIN');

    // Enable UUID extension
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // =====================
    // USERS / STAFF
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        full_name VARCHAR(100) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        phone VARCHAR(20),
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'waiter' CHECK (role IN ('administrator','manager','head_chef','cashier','waiter','kitchen_staff','cleaner')),
        status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','on_leave')),
        -- Account approval gate, separate from 'status' above (which is a
        -- work-schedule state — active/on_leave/inactive — not whether the
        -- account itself is allowed to log in at all). Admin-created staff
        -- (via the Staff page) are auto-approved; only self-service signups
        -- start as 'pending' and are blocked from logging in until an admin
        -- approves them.
        approval_status VARCHAR(20) NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending','approved','rejected')),
        schedule_type VARCHAR(20) DEFAULT 'full_time' CHECK (schedule_type IN ('full_time','part_time')),
        avatar_url VARCHAR(500),
        joined_date DATE DEFAULT CURRENT_DATE,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // MENU CATEGORIES
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_categories (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // MENU ITEMS
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        category_id UUID REFERENCES menu_categories(id) ON DELETE SET NULL,
        name VARCHAR(150) NOT NULL,
        description TEXT,
        price DECIMAL(10,2) NOT NULL,
        cost DECIMAL(10,2) DEFAULT 0,
        image_url VARCHAR(500),
        preparation_time INTEGER DEFAULT 15,
        status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available','unavailable','out_of_stock','archived')),
        tags TEXT[],
        is_featured BOOLEAN DEFAULT false,
        sort_order INTEGER DEFAULT 0,
        -- Countable finished-goods stock (chapati, samosa, soda — pre-made
        -- units sold as-is), distinct from the ingredient-based
        -- recipe_ingredients deduction used for cooked-to-order dishes. A menu
        -- item can use either, both, or neither.
        track_stock BOOLEAN NOT NULL DEFAULT false,
        stock_quantity INTEGER NOT NULL DEFAULT 0,
        reorder_level INTEGER NOT NULL DEFAULT 5,
        -- For POS "Scan" — matched against what a USB barcode scanner types
        -- (they act as keyboard input, typing the code then Enter, not a
        -- camera/image-based scan). NULL for items with no assigned code;
        -- UNIQUE only enforces uniqueness among the non-null values, so
        -- multiple items can stay unset simultaneously.
        barcode VARCHAR(100) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // MENU MODIFIERS
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_modifiers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL,
        type VARCHAR(20) DEFAULT 'single' CHECK (type IN ('single','multiple')),
        is_required BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_modifier_options (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        modifier_id UUID REFERENCES menu_modifiers(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        price_adjustment DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_item_modifiers (
        menu_item_id UUID REFERENCES menu_items(id) ON DELETE CASCADE,
        modifier_id UUID REFERENCES menu_modifiers(id) ON DELETE CASCADE,
        PRIMARY KEY (menu_item_id, modifier_id)
      )
    `);

    // =====================
    // SUPPLIERS
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(150) NOT NULL,
        contact_person VARCHAR(100),
        phone VARCHAR(20),
        email VARCHAR(150),
        address TEXT,
        notes TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // INVENTORY
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        sku VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(150) NOT NULL,
        description TEXT,
        category VARCHAR(100),
        supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        quantity DECIMAL(10,2) DEFAULT 0,
        unit VARCHAR(30) NOT NULL DEFAULT 'Kg',
        cost_per_unit DECIMAL(10,2) DEFAULT 0,
        reorder_level DECIMAL(10,2) DEFAULT 0,
        expiry_date DATE,
        location VARCHAR(100) DEFAULT 'Main Store',
        image_url VARCHAR(500),
        -- Soft-delete flag, same pattern as menu_items/restaurant_tables.
        -- Never hard-delete: inventory_transactions' audit history and
        -- recipe_ingredients (ON DELETE CASCADE) both reference this row.
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_transactions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
        type VARCHAR(30) NOT NULL CHECK (type IN ('purchase','adjustment','sale','waste','transfer')),
        quantity_change DECIMAL(10,2) NOT NULL,
        quantity_before DECIMAL(10,2) NOT NULL,
        quantity_after DECIMAL(10,2) NOT NULL,
        notes TEXT,
        reference_id UUID,
        performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // RECIPE INGREDIENTS (bill of materials for menu items)
    // =====================
    // Links a menu item to the inventory items it consumes, and how much of
    // each per single item sold. This is what drives automatic stock
    // deduction on sale (see services/inventoryService.ts). quantity_per_item
    // is DECIMAL(12,3) so small per-serving amounts (e.g. 0.005 Kg of salt)
    // survive without rounding to zero.
    await client.query(`
      CREATE TABLE IF NOT EXISTS recipe_ingredients (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
        inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
        quantity_per_item DECIMAL(12,3) NOT NULL CHECK (quantity_per_item > 0),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (menu_item_id, inventory_item_id)
      )
    `);

    // =====================
    // MENU STOCK TRANSACTIONS (countable finished-goods audit ledger)
    // =====================
    // Mirrors inventory_transactions but for menu_items.stock_quantity — the
    // audit trail for unit-counted items (chapati, samosa, soda) rather than
    // ingredient grams/litres. Kept as its own table rather than overloading
    // inventory_transactions because that table's inventory_item_id FK points
    // at inventory_items, not menu_items.
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_stock_transactions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL CHECK (type IN ('sale','restock','adjustment')),
        quantity_change INTEGER NOT NULL,
        quantity_before INTEGER NOT NULL,
        quantity_after INTEGER NOT NULL,
        notes TEXT,
        reference_id UUID,
        performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // PURCHASE ORDERS
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        po_number VARCHAR(50) UNIQUE NOT NULL,
        supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
        status VARCHAR(30) DEFAULT 'draft' CHECK (status IN ('draft','pending','partially_received','received','cancelled')),
        order_date DATE DEFAULT CURRENT_DATE,
        expected_date DATE,
        received_date DATE,
        subtotal DECIMAL(10,2) DEFAULT 0,
        discount DECIMAL(10,2) DEFAULT 0,
        tax DECIMAL(10,2) DEFAULT 0,
        total_amount DECIMAL(10,2) DEFAULT 0,
        payment_status VARCHAR(30) DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid')),
        notes TEXT,
        attachment_url VARCHAR(500),
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE CASCADE,
        inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
        item_name VARCHAR(150) NOT NULL,
        unit VARCHAR(30) NOT NULL,
        quantity_ordered DECIMAL(10,2) NOT NULL,
        quantity_received DECIMAL(10,2) DEFAULT 0,
        unit_price DECIMAL(10,2) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // CUSTOMERS
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        customer_code VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(150),
        address TEXT,
        city VARCHAR(100),
        tags TEXT[],
        notes TEXT,
        is_vip BOOLEAN DEFAULT false,
        credit_limit DECIMAL(10,2) DEFAULT 0,
        credit_balance DECIMAL(10,2) DEFAULT 0,
        avatar_url VARCHAR(500),
        sms_notifications BOOLEAN DEFAULT true,
        email_notifications BOOLEAN DEFAULT true,
        whatsapp_notifications BOOLEAN DEFAULT false,
        marketing_offers BOOLEAN DEFAULT false,
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','inactive')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // LOYALTY PROGRAM
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_tiers (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(50) NOT NULL UNIQUE,
        min_points INTEGER NOT NULL DEFAULT 0,
        discount_percentage DECIMAL(5,2) DEFAULT 0,
        benefits TEXT[],
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_points (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        customer_id UUID REFERENCES customers(id) ON DELETE CASCADE UNIQUE,
        total_points INTEGER DEFAULT 0,
        available_points INTEGER DEFAULT 0,
        redeemed_points INTEGER DEFAULT 0,
        tier_id UUID REFERENCES loyalty_tiers(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL CHECK (type IN ('earn','redeem','adjust','expire')),
        points INTEGER NOT NULL,
        description TEXT,
        reference_id UUID,
        performed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_rewards (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        points_cost INTEGER NOT NULL,
        reward_type VARCHAR(30) CHECK (reward_type IN ('discount_voucher','free_item','cash_voucher')),
        reward_value DECIMAL(10,2),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // TABLES
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS restaurant_tables (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        table_number VARCHAR(10) UNIQUE NOT NULL,
        area VARCHAR(50) DEFAULT 'Main Hall',
        capacity INTEGER NOT NULL DEFAULT 2,
        status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available','occupied','reserved','cleaning')),
        current_order_id UUID,
        -- Soft-delete flag. Deleting a table is a soft delete (not a real
        -- DROP) so historical orders keep resolving their table_number via
        -- the FK join in getOrderById instead of losing it the moment a
        -- table is removed from the floor plan.
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        table_id UUID REFERENCES restaurant_tables(id) ON DELETE SET NULL,
        customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
        customer_name VARCHAR(100),
        customer_phone VARCHAR(20),
        guests INTEGER NOT NULL DEFAULT 1,
        -- TIMESTAMPTZ (not plain TIMESTAMP) so this always stores an
        -- unambiguous instant regardless of the database server's own
        -- session timezone. Comparisons against "today" are done with an
        -- explicit AT TIME ZONE 'Africa/Nairobi' — see updateReservationStatus
        -- and createReservation in tablesController.ts — rather than relying
        -- on whatever timezone the Node process happens to run in, which is
        -- what caused reservations near the day boundary to inconsistently
        -- mark (or fail to mark) a table as reserved.
        reservation_time TIMESTAMPTZ NOT NULL,
        duration_minutes INTEGER DEFAULT 90,
        status VARCHAR(20) DEFAULT 'confirmed' CHECK (status IN ('confirmed','seated','completed','cancelled','no_show')),
        notes TEXT,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // ORDERS
    // =====================
    // NOTE on status: 'awaiting_payment' is the transient state used while an
    // M-Pesa STK push is in flight. The order is NOT counted as real revenue,
    // does not occupy kitchen workflow, and is auto-expired by the sweep job
    // in mpesaController if the customer never completes the prompt.
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_number VARCHAR(50) UNIQUE NOT NULL,
        type VARCHAR(20) NOT NULL DEFAULT 'dine_in' CHECK (type IN ('dine_in','takeaway','delivery')),
        status VARCHAR(30) NOT NULL DEFAULT 'new' CHECK (status IN ('awaiting_payment','new','preparing','ready','completed','cancelled')),
        table_id UUID REFERENCES restaurant_tables(id) ON DELETE SET NULL,
        customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
        customer_name VARCHAR(100),
        guests INTEGER DEFAULT 1,
        subtotal DECIMAL(10,2) DEFAULT 0,
        discount DECIMAL(10,2) DEFAULT 0,
        service_charge DECIMAL(10,2) DEFAULT 0,
        tax DECIMAL(10,2) DEFAULT 0,
        total DECIMAL(10,2) DEFAULT 0,
        amount_paid DECIMAL(10,2) NOT NULL DEFAULT 0,
        inventory_deducted BOOLEAN NOT NULL DEFAULT false,
        special_instructions TEXT,
        served_by UUID REFERENCES users(id) ON DELETE SET NULL,
        -- Client-generated key, used by the offline sync queue (and as a
        -- side benefit, protects against an accidental double-submit from a
        -- slow network response) — a repeat request with the same key
        -- returns the order already created instead of making a second one.
        client_reference_id VARCHAR(100) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
        menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
        item_name VARCHAR(150) NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price DECIMAL(10,2) NOT NULL,
        total_price DECIMAL(10,2) NOT NULL,
        modifiers JSONB,
        special_instructions TEXT,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','preparing','ready','served','cancelled')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // PAYMENTS
    // =====================
    // `reference` is UNIQUE because it holds the Daraja CheckoutRequestID for
    // mpesa rows — without uniqueness, a retried/duplicated STK push or a
    // replayed callback can silently create or update the wrong row.
    // `expires_at` lets the sweep job in mpesaController auto-fail STK pushes
    // that Safaricom never calls back on (network blip, customer ignored it).
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
        payment_method VARCHAR(30) NOT NULL CHECK (payment_method IN ('cash','mpesa','card','till','split','points')),
        amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','cancelled','expired','refunded')),
        reference VARCHAR(100) UNIQUE,
        mpesa_transaction_id VARCHAR(100),
        mpesa_phone VARCHAR(20),
        mpesa_merchant_request_id VARCHAR(100),
        result_code VARCHAR(10),
        result_desc TEXT,
        split_details JSONB,
        expires_at TIMESTAMP,
        -- Cash/card payments apply loyalty immediately (see processPayment),
        -- so the choice and the effect happen in the same request. M-Pesa
        -- can't do that — the STK push is initiated now, but the payment
        -- only actually completes later when Safaricom's callback (or the
        -- status poll) fires, quite possibly seconds to minutes afterward.
        -- This column is where that earlier choice waits until then.
        award_loyalty BOOLEAN NOT NULL DEFAULT true,
        -- Only set when payment_method='points'. Recorded here (not just
        -- derived from amount / current point value) because the point
        -- value is itself a setting that can change later — this keeps the
        -- receipt and the payments ledger showing exactly what was redeemed
        -- at the time, regardless of any rate change afterward.
        points_redeemed INTEGER,
        client_reference_id VARCHAR(100) UNIQUE,
        processed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // REFUNDS
    // =====================
    // Immutable record of money returned to a customer — the audit source of
    // truth for money-OUT, kept separate from `payments` (money-IN) so neither
    // history is ever mutated to represent the other. A full refund of an
    // order's balance also voids the order (status -> cancelled); partial
    // refunds leave the order in place. `orders.amount_paid` is kept as the NET
    // amount currently retained, so it decreases as refunds are issued.
    await client.query(`
      CREATE TABLE IF NOT EXISTS refunds (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
        amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
        reason TEXT,
        method VARCHAR(30) NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','mpesa','card','store_credit')),
        is_void BOOLEAN NOT NULL DEFAULT false,
        restocked BOOLEAN NOT NULL DEFAULT false,
        points_reversed INTEGER NOT NULL DEFAULT 0,
        processed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // HELD ORDERS (POS "Hold Order" / "Save Draft")
    // =====================
    // A suspended cart, not yet a real order — nothing here touches inventory,
    // the kitchen, or a table's occupied status. It exists purely so a cashier
    // can park an in-progress sale (customer stepped away, kitchen wants to
    // confirm an item) and resume it later without re-entering everything.
    // `items` is an opaque JSONB snapshot of the POS cart; when resumed, the
    // items are loaded back into the cart and go through the normal
    // createOrder path, which re-prices everything from the menu table anyway
    // — so a stale snapshot price here is harmless, never authoritative.
    // `label` distinguishes a named "Save Draft" from an anonymous "Hold
    // Order" quick-park; both use this same table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS held_orders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        label VARCHAR(100),
        type VARCHAR(20) NOT NULL DEFAULT 'dine_in' CHECK (type IN ('dine_in','takeaway','delivery')),
        table_id UUID REFERENCES restaurant_tables(id) ON DELETE SET NULL,
        table_number VARCHAR(20),
        customer_name VARCHAR(100),
        items JSONB NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 0,
        subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // EXPENSES
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS expense_categories (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL UNIQUE,
        color VARCHAR(7) DEFAULT '#6B7280',
        icon VARCHAR(50),
        budget_limit DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title VARCHAR(200) NOT NULL,
        description TEXT,
        category_id UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
        vendor VARCHAR(150),
        amount DECIMAL(10,2) NOT NULL,
        payment_method VARCHAR(30) CHECK (payment_method IN ('cash','mpesa','bank_transfer','card')),
        expense_date DATE DEFAULT CURRENT_DATE,
        reference_no VARCHAR(100),
        receipt_url VARCHAR(500),
        notes TEXT,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // SETTINGS
    // =====================
    // Key-value rather than rigid columns — General and Business Profile
    // settings are a loose, evolving bag of small preferences (language,
    // currency display, business contact details, logo URL), not a
    // relational structure with its own meaningful joins. A fixed-column
    // table would need a migration every time a new setting is added; this
    // doesn't.
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // Email login code (OTP 2FA) defaults to ON — this is a security
    // mechanism that should actually be in effect rather than something
    // that only works once someone happens to discover the toggle in
    // Settings. ON CONFLICT DO NOTHING means this only sets the *initial*
    // value: if this key already exists (someone already saved a choice,
    // on or off), that choice is left exactly as it is.
    await client.query(`
      INSERT INTO settings (key, value) VALUES ('otp_login_enabled', 'true')
      ON CONFLICT (key) DO NOTHING
    `);

    // =====================
    // AUDIT LOGS
    // =====================
    // A dedicated, append-only trail for security-sensitive actions — found
    // missing entirely during a security review. Before this, there was no
    // way to answer "who approved this staff account", "who changed this
    // menu price", "who processed this refund", or "who just tried to log
    // in and failed five times". user_id is nullable and full_name/email
    // are captured as plain text at the time of the event (not just a
    // foreign key) specifically so the trail survives a user being deleted
    // later — an audit log that goes blank the moment the account it's
    // about is removed defeats much of its own purpose.
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        user_name VARCHAR(150),
        user_email VARCHAR(150),
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50),
        entity_id VARCHAR(100),
        details JSONB,
        ip_address VARCHAR(64),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)`);

    // =====================
    // PASSWORD RESETS
    // =====================
    // Only the HASH of the reset token is ever stored — the raw token only
    // ever exists in the emailed link itself and in the requester's memory
    // for the few minutes it takes to click it. This mirrors how passwords
    // themselves are handled (bcrypt hash only) and means a database leak
    // alone can't be used to forge a password reset.
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)`);

    // =====================
    // LOGIN OTPs (2FA)
    // =====================
    // Second factor after a correct email/password — the OTP itself is
    // never stored in plain text, same reasoning as password_resets:
    // a database read alone shouldn't be enough to complete a login.
    // Short-lived (5 minutes, enforced in authController) and single-use.
    await client.query(`
      CREATE TABLE IF NOT EXISTS login_otps (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        otp_hash VARCHAR(64) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_login_otps_user ON login_otps(user_id)`);

    // =====================
    // STAFF SCHEDULING
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_schedules (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        shift_date DATE NOT NULL,
        shift_type VARCHAR(30) CHECK (shift_type IN ('morning','day','evening','night','off')),
        start_time TIME,
        end_time TIME,
        role_label VARCHAR(50),
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, shift_date)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        reason TEXT,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
        reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // NOTIFICATIONS
    // =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(30) DEFAULT 'info' CHECK (type IN ('info','warning','error','success')),
        is_read BOOLEAN DEFAULT false,
        reference_type VARCHAR(50),
        reference_id UUID,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // =====================
    // INDEXES
    // =====================
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_pending_expiry ON payments(status, expires_at) WHERE status = 'pending'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_awaiting_payment ON orders(status, created_at) WHERE status = 'awaiting_payment'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory_items(quantity)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_points(customer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_schedules_date ON staff_schedules(shift_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recipe_menu_item ON recipe_ingredients(menu_item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recipe_inventory_item ON recipe_ingredients(inventory_item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_txn_reference ON inventory_transactions(reference_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON refunds(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_menu_stock_txn_item ON menu_stock_transactions(menu_item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_menu_stock_txn_reference ON menu_stock_transactions(reference_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_held_orders_created_at ON held_orders(created_at)`);

    // ── One-time menu de-duplication + guard ────────────────────────────────
    // The seeder inserted menu items with `ON CONFLICT DO NOTHING`, but there
    // was no unique constraint for that conflict to fire on — so every re-run
    // of the seed appended another full copy of the menu (hence the doubled
    // items in the UI). This collapses any existing duplicates (keeping the
    // earliest row per name and repointing child rows to it), then adds the
    // UNIQUE(name) constraint that makes `ON CONFLICT DO NOTHING` actually work
    // and prevents this from ever happening again. The whole block is skipped
    // once the constraint exists, so it's safe to run on every migration.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_name_unique') THEN
          -- Preserve order history: repoint order_items from duplicate rows to
          -- the surviving (earliest) row of the same name.
          UPDATE order_items o SET menu_item_id = k.keep_id
          FROM (SELECT id, FIRST_VALUE(id) OVER (PARTITION BY name ORDER BY created_at, id) AS keep_id FROM menu_items) k
          WHERE o.menu_item_id = k.id AND k.id <> k.keep_id;

          -- Duplicates' recipe rows and modifier links are redundant with the
          -- survivor's (same name => same seed-applied children), so drop them.
          DELETE FROM recipe_ingredients ri USING (
            SELECT id, FIRST_VALUE(id) OVER (PARTITION BY name ORDER BY created_at, id) AS keep_id FROM menu_items
          ) k WHERE ri.menu_item_id = k.id AND k.id <> k.keep_id;

          DELETE FROM menu_item_modifiers mm USING (
            SELECT id, FIRST_VALUE(id) OVER (PARTITION BY name ORDER BY created_at, id) AS keep_id FROM menu_items
          ) k WHERE mm.menu_item_id = k.id AND k.id <> k.keep_id;

          DELETE FROM menu_items m USING (
            SELECT id, FIRST_VALUE(id) OVER (PARTITION BY name ORDER BY created_at, id) AS keep_id FROM menu_items
          ) k WHERE m.id = k.id AND k.id <> k.keep_id;

          ALTER TABLE menu_items ADD CONSTRAINT menu_items_name_unique UNIQUE (name);
        END IF;
      END $$;
    `);

    // Countable finished-goods stock on menu_items (chapati/samosa/soda-style
    // pre-made units). Additive so existing v1.0 databases pick these up
    // without a destructive rebuild.
    await client.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stock_quantity INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS reorder_level INTEGER NOT NULL DEFAULT 5`);

    // Table CRUD (add/delete tables) — soft-delete flag on existing databases.
    await client.query(`ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);
    await client.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);

    // Account approval gate. Existing users (all admin-created up to this
    // point) default to 'approved' so this change never locks anyone
    // currently in the system out.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'approved'`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_approval_status_check') THEN
          ALTER TABLE users ADD CONSTRAINT users_approval_status_check CHECK (approval_status IN ('pending','approved','rejected'));
        END IF;
      END $$;
    `);

    // Fix for the reservation day-boundary bug: convert reservation_time from
    // a naive TIMESTAMP to TIMESTAMPTZ on existing databases. Guarded so this
    // only ever runs once — re-interpreting an already-correct TIMESTAMPTZ
    // value as if it were still naive would corrupt it. Existing naive values
    // are assumed to have been intended as Africa/Nairobi wall-clock time
    // (the business's actual location), which is the same assumption the
    // application logic now makes consistently everywhere.
    await client.query(`
      DO $$
      BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name = 'reservations' AND column_name = 'reservation_time') = 'timestamp without time zone' THEN
          ALTER TABLE reservations ALTER COLUMN reservation_time TYPE TIMESTAMPTZ
            USING reservation_time AT TIME ZONE 'Africa/Nairobi';
        END IF;
      END $$;
    `);

    // =====================
    // ADDITIVE SCHEMA PATCHES (safe to re-run on a pre-existing v1.0 database)
    // =====================
    // These ALTERs exist because CREATE TABLE IF NOT EXISTS above is a no-op
    // on a database that already has `orders`/`payments` from before this
    // payments hardening pass. Every statement here is idempotent.
    // menu_items: allow 'archived' for soft-delete (hard delete breaks order history)
    await client.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_status_check;
          ALTER TABLE menu_items ADD CONSTRAINT menu_items_status_check
            CHECK (status IN ('available','unavailable','out_of_stock','archived'));
        EXCEPTION WHEN check_violation THEN
          RAISE NOTICE 'Skipping menu_items status CHECK update.';
        END;
      END $$;
    `);

    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(10,2) NOT NULL DEFAULT 0`);
    // Automatic stock deduction bookkeeping. Defaults to false; deduction only
    // ever fires from createOrder / M-Pesa confirmation for orders placed after
    // this feature ships, so historical orders are never retroactively deducted
    // (nothing reads this flag except the live deduct/restock service, which is
    // only invoked on the new-order and cancellation code paths).
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_deducted BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
          ALTER TABLE orders ADD CONSTRAINT orders_status_check
            CHECK (status IN ('awaiting_payment','new','preparing','ready','completed','cancelled'));
        EXCEPTION WHEN check_violation THEN
          RAISE NOTICE 'Skipping orders status CHECK update — existing rows have a status outside the expected set.';
        END;
      END $$;
    `);

    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS mpesa_merchant_request_id VARCHAR(100)`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS result_code VARCHAR(10)`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS result_desc TEXT`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP`);
    await client.query(`
      DO $$
      BEGIN
        BEGIN
          ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
          ALTER TABLE payments ADD CONSTRAINT payments_status_check
            CHECK (status IN ('pending','completed','failed','cancelled','expired','refunded'));
        EXCEPTION WHEN check_violation THEN
          RAISE NOTICE 'Skipping payments status CHECK update — existing rows have a status outside the expected set.';
        END;
      END $$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'payments_amount_check'
        ) THEN
          BEGIN
            ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK (amount > 0);
          EXCEPTION WHEN check_violation THEN
            RAISE NOTICE 'Skipping CHECK(amount > 0) on payments — existing rows violate it (likely a historical zero/negative-amount row). Clean up manually, then re-run migration.';
          END;
        END IF;
      END $$;
    `);
    // Add UNIQUE on reference only if existing data doesn't already violate it
    // (NULLs are always allowed under UNIQUE; duplicates among non-null values would block this)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'payments_reference_key'
        ) THEN
          BEGIN
            ALTER TABLE payments ADD CONSTRAINT payments_reference_key UNIQUE (reference);
          EXCEPTION WHEN unique_violation THEN
            RAISE NOTICE 'Skipping UNIQUE(reference) on payments — existing duplicate references found. Clean up manually, then re-run migration.';
          END;
        END IF;
      END $$;
    `);

    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS award_loyalty BOOLEAN NOT NULL DEFAULT true`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS points_redeemed INTEGER`);
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_reference_id VARCHAR(100)`);
    await client.query(`ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_client_reference_id_key') THEN
          ALTER TABLE payments ADD CONSTRAINT payments_client_reference_id_key UNIQUE (client_reference_id);
        END IF;
      END $$;
    `);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_reference_id VARCHAR(100)`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_client_reference_id_key') THEN
          ALTER TABLE orders ADD CONSTRAINT orders_client_reference_id_key UNIQUE (client_reference_id);
        END IF;
      END $$;
    `);
    // Existing installations already have the old CHECK constraint baked in
    // (changing the CREATE TABLE statement above only affects brand new
    // databases) — drop and recreate it, now also including 'till' (M-Pesa
    // Buy Goods paid directly to the till by the customer's own phone,
    // confirmed manually by the cashier — same idea as cash/card, no STK
    // push or API integration involved).
    await client.query(`ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check`);
    await client.query(`ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check CHECK (payment_method IN ('cash','mpesa','card','till','split','points'))`);

    await client.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS barcode VARCHAR(100)`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_barcode_key') THEN
          BEGIN
            ALTER TABLE menu_items ADD CONSTRAINT menu_items_barcode_key UNIQUE (barcode);
          EXCEPTION WHEN unique_violation THEN
            RAISE NOTICE 'Skipping UNIQUE(barcode) on menu_items — existing duplicate barcodes found. Clean up manually, then re-run migration.';
          END;
        END IF;
      END $$;
    `);

    // Chef accountability — separate from served_by (who took/rang up the
    // order, usually a cashier/waiter). This is specifically who actually
    // cooked it: set the moment an order moves to 'preparing', so if a
    // dish comes back wrong there's a real answer to "who made this",
    // not just who sold it.
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS prepared_by UUID REFERENCES users(id) ON DELETE SET NULL`);

    // Web Push subscriptions — lets the backend notify a kitchen staff
    // member's phone the moment a new order comes in, without needing a
    // native app or any SMS cost. One row per device a person has opted
    // in on (the same person could reasonably have this open on both a
    // kitchen tablet and their own phone) — endpoint is unique per
    // device/browser registration, so re-subscribing the same device just
    // updates its existing row instead of accumulating duplicates.
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        subscription JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Refund approval workflow — deliberately a separate table from the
    // existing, immutable `refunds` ledger rather than a status column
    // bolted onto it. A request is a proposal: revocable, reviewable,
    // and — critically — has NOT moved any money yet. Only once an admin
    // approves does the real refund get executed (writing the actual
    // `refunds` row via the same processRefund logic administrators use
    // for a direct refund). Declined requests never touch amount_paid,
    // order status, loyalty points, or stock — nothing happens until
    // there's a real approval.
    await client.query(`
      CREATE TABLE IF NOT EXISTS refund_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        amount DECIMAL(10,2),
        reason TEXT NOT NULL,
        method VARCHAR(20),
        restock BOOLEAN NOT NULL DEFAULT false,
        is_void BOOLEAN NOT NULL DEFAULT false,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
        requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP,
        decline_reason TEXT,
        refund_id UUID REFERENCES refunds(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Set once per staff member (e.g. "Daniel is off every Sunday") rather
    // than needing a fresh staff_schedules row created every single week —
    // that per-date table is for actual shift assignments and one-off
    // exceptions, not a recurring pattern. 0=Sunday..6=Saturday, matching
    // JS Date.getDay(); NULL means no recurring day off is set. The
    // scheduling grid treats this as a fallback: an explicit staff_schedules
    // entry for a given date (e.g. someone covering that Sunday, or a sick
    // day) always overrides it — this is just what happens by default when
    // nothing else has been said about that day.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS recurring_day_off SMALLINT CHECK (recurring_day_off BETWEEN 0 AND 6)`);

    // Check-in/check-out — a real attendance record distinct from the
    // schedule itself (staff_schedules says who's SUPPOSED to work when;
    // this is what actually happened). One row per person per day: a second
    // check-in the same day updates the same row rather than creating a
    // duplicate, since a shift only has one real start and end.
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_attendance (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        attendance_date DATE NOT NULL DEFAULT CURRENT_DATE,
        check_in_time TIMESTAMP,
        check_out_time TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, attendance_date)
      )
    `);

    // Sick-off requests — a staff member asks for a specific day off with a
    // reason and a supporting document (e.g. a hospital note), an admin
    // reviews and approves or declines it. Approving one is handled in the
    // controller by also writing a real 'off' row to staff_schedules for
    // that date, so the schedule grid and this request stay in sync rather
    // than being two separate sources of truth for the same day off.
    await client.query(`
      CREATE TABLE IF NOT EXISTS sick_off_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        requested_date DATE NOT NULL,
        message TEXT,
        receipt_url VARCHAR(500),
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
        reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP,
        decline_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query('COMMIT');
    console.log('✅ All tables created successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

createTables()
  .then(() => {
    console.log("✅ Migration completed successfully.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Migration failed with error:");
    console.error(err);
    process.exit(1);
  });