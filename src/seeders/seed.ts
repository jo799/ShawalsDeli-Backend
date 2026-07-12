import { pool } from '../config/database';
import bcrypt from 'bcryptjs';

const seed = async () => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Seed loyalty tiers
    await client.query(`
      INSERT INTO loyalty_tiers (name, min_points, discount_percentage, benefits) VALUES
        ('Bronze', 0, 0, ARRAY['Welcome Reward', 'Member Offers']),
        ('Silver', 500, 5, ARRAY['5% Discount', 'Special Offers']),
        ('Gold', 1000, 10, ARRAY['10% Discount', 'Birthday Reward'])
      ON CONFLICT (name) DO NOTHING
    `);

    // Seed users
    const passwordHash = await bcrypt.hash('password123', 12);
    await client.query(`
      INSERT INTO users (full_name, email, phone, password_hash, role, status, schedule_type, joined_date) VALUES
        ('Joseph Kimunya', 'joseph.kimunya@shawalsdei.com', '0712 345 678', $1, 'administrator', 'active', 'full_time', '2023-01-10'),
        ('Mary Njeri', 'mary.njeri@shawalsdei.com', '0701 234 567', $1, 'manager', 'active', 'full_time', '2023-02-05'),
        ('Peter Mwangi', 'peter.mwangi@shawalsdei.com', '0722 345 890', $1, 'head_chef', 'active', 'full_time', '2023-03-12'),
        ('Alice Wanjiku', 'alice.wanjiku@shawalsdei.com', '0708 765 432', $1, 'cashier', 'active', 'full_time', '2023-04-03'),
        ('Brian Otieno', 'brian.otieno@shawalsdei.com', '0716 234 891', $1, 'waiter', 'active', 'full_time', '2023-05-18'),
        ('Sarah Ndungu', 'sarah.ndungu@shawalsdei.com', '0700 987 654', $1, 'waiter', 'active', 'part_time', '2023-06-01'),
        ('Daniel Kamau', 'daniel.kamau@shawalsdei.com', '0714 456 789', $1, 'kitchen_staff', 'active', 'full_time', '2023-07-08'),
        ('Grace Mutua', 'grace.mutua@shawalsdei.com', '0720 333 222', $1, 'cleaner', 'on_leave', 'part_time', '2023-08-15')
      ON CONFLICT (email) DO NOTHING
    `, [passwordHash]);

    // Seed menu categories
    await client.query(`
      INSERT INTO menu_categories (name, description, sort_order) VALUES
        ('Main Dishes', 'Hearty main course dishes', 1),
        ('Swahili Specials', 'Authentic Swahili cuisine', 2),
        ('Sides', 'Side dishes and accompaniments', 3),
        ('Drinks', 'Beverages and refreshments', 4),
        ('Desserts', 'Sweet treats and desserts', 5),
        ('Breakfast', 'Morning meals', 6),
        ('Snacks', 'Light bites and snacks', 7)
      ON CONFLICT (name) DO NOTHING
    `);

    // Seed menu items
    await client.query(`
      INSERT INTO menu_items (name, description, price, cost, preparation_time, status, tags, is_featured,
        category_id)
      SELECT items.item_name, items.description, items.price, items.cost, items.prep_time,
             'available', items.tags, items.featured, c.id
      FROM (VALUES
        ('Pilau', 'Aromatic spiced rice cooked with tender beef, served with kachumbari.', 900, 450, 30, ARRAY['Popular','Best Seller']::text[], true, 'Main Dishes'),
        ('Beef Stew', 'Slow-cooked tender beef in rich tomato gravy with vegetables.', 550, 250, 25, ARRAY['Popular']::text[], false, 'Main Dishes'),
        ('Beef Pilau', 'Generous pilau with extra beef portions.', 500, 230, 30, ARRAY['Popular']::text[], false, 'Main Dishes'),
        ('Chicken Curry', 'Kenyan-style chicken curry with coconut milk.', 550, 240, 25, ARRAY[]::text[], false, 'Main Dishes'),
        ('Samaki Wa Kupaka', 'Grilled fish in coconut sauce, a Swahili classic.', 650, 300, 35, ARRAY['Popular']::text[], false, 'Swahili Specials'),
        ('Wali wa Nazi', 'Coconut rice cooked in fresh coconut milk.', 200, 80, 20, ARRAY[]::text[], false, 'Swahili Specials'),
        ('Biryani', 'Fragrant basmati rice with spiced meat.', 850, 400, 40, ARRAY[]::text[], false, 'Swahili Specials'),
        ('Ugali', 'Classic Kenyan staple made from maize flour.', 100, 30, 10, ARRAY['Vegan']::text[], false, 'Sides'),
        ('Kachumbari', 'Fresh tomato and onion salad with coriander.', 100, 40, 5, ARRAY['Vegan']::text[], false, 'Sides'),
        ('Chapati', 'Soft layered flatbread, freshly made.', 120, 50, 15, ARRAY['Vegan']::text[], false, 'Sides'),
        ('Sukuma Wiki', 'Sautéed kale with onions and tomatoes.', 80, 30, 10, ARRAY['Vegan']::text[], false, 'Sides'),
        ('Fresh Juice', 'Freshly squeezed fruit juice of the day.', 200, 80, 5, ARRAY[]::text[], false, 'Drinks'),
        ('Soda', 'Assorted soft drinks.', 120, 60, 2, ARRAY[]::text[], false, 'Drinks'),
        ('Water', 'Bottled mineral water.', 60, 25, 1, ARRAY[]::text[], false, 'Drinks'),
        ('Coffee', 'Freshly brewed Kenyan coffee.', 150, 60, 5, ARRAY[]::text[], false, 'Drinks'),
        ('Tea', 'Kenyan chai with milk.', 80, 30, 5, ARRAY[]::text[], false, 'Drinks'),
        ('Coconut Pudding', 'Creamy coconut dessert with caramel.', 250, 100, 10, ARRAY[]::text[], false, 'Desserts'),
        ('Mandazi', 'Sweet Swahili doughnuts, 3 pieces.', 100, 40, 10, ARRAY['Vegan']::text[], false, 'Snacks'),
        ('Samosa', 'Crispy pastry filled with spiced meat.', 100, 40, 5, ARRAY[]::text[], false, 'Snacks'),
        ('Soup', 'Hearty bone broth soup.', 250, 100, 15, ARRAY[]::text[], false, 'Snacks'),
        ('Mahamri', 'Sweet coconut doughnuts.', 100, 40, 10, ARRAY[]::text[], false, 'Snacks'),
        ('Uji', 'Traditional porridge, lightly sweetened.', 150, 50, 10, ARRAY['Vegan']::text[], false, 'Breakfast')
      ) AS items(item_name, description, price, cost, prep_time, tags, featured, cat_name)
      JOIN menu_categories c ON c.name = items.cat_name
      ON CONFLICT DO NOTHING
    `);

    // Seed suppliers
    await client.query(`
      INSERT INTO suppliers (name, contact_person, phone, email, address) VALUES
        ('Kamau Suppliers Ltd', 'James Kamau', '0712 345 678', 'james@kamausuppliers.co.ke', 'Industrial Area, Nairobi'),
        ('Fresh Produce Co.', 'Janet Wambua', '0721 456 789', 'janet@freshproduce.co.ke', 'City Market, Nairobi'),
        ('Meat World Ltd', 'Peter Njoroge', '0733 987 654', 'peter@meatworld.co.ke', 'Kenyatta Market, Nairobi'),
        ('Dairy Best Ltd', 'Grace Achieng', '0701 234 567', 'grace@dairybest.co.ke', 'Westlands, Nairobi'),
        ('Dry Goods Ltd', 'Samuel Mutua', '0722 111 222', 'samuel@drygoods.co.ke', 'Gikomba, Nairobi'),
        ('K-Gas Limited', 'Faith Wanjiru', '0715 876 543', 'faith@kgas.co.ke', 'Industrial Area, Nairobi'),
        ('Bestcare Supplies', 'John Odhiambo', '0709 543 210', 'john@bestcare.co.ke', 'Kikuyu, Kiambu')
      ON CONFLICT DO NOTHING
    `);

    // Seed inventory
    await client.query(`
      INSERT INTO inventory_items (sku, name, description, category, quantity, unit, cost_per_unit, reorder_level, location)
      VALUES
        ('ING-0001', 'Rice', 'Long grain basmati rice', 'Grains', 120, 'Kg', 120, 20, 'Main Store'),
        ('ING-0002', 'Beef', 'Fresh beef', 'Meat', 18, 'Kg', 680, 5, 'Cold Room'),
        ('ING-0003', 'Cooking Oil', 'Pure vegetable oil', 'Oils', 5, 'L', 450, 10, 'Main Store'),
        ('ING-0004', 'Onions', 'Fresh red onions', 'Vegetables', 2, 'Kg', 120, 5, 'Main Store'),
        ('ING-0005', 'Tomatoes', 'Fresh tomatoes', 'Vegetables', 0, 'Kg', 180, 5, 'Main Store'),
        ('ING-0006', 'Pilau Masala', 'Pilau spice mix', 'Spices', 8, 'Pcs', 250, 3, 'Main Store'),
        ('ING-0007', 'Wheat Flour', 'All purpose flour', 'Baking', 3, 'Kg', 150, 10, 'Main Store'),
        ('ING-0008', 'Milk', 'Full cream milk', 'Dairy', 0, 'L', 210, 10, 'Cold Room'),
        ('ING-0009', 'Chicken', 'Fresh whole chicken', 'Meat', 12, 'Kg', 450, 5, 'Cold Room'),
        ('ING-0010', 'Coconut Milk', 'Canned coconut milk', 'Baking', 24, 'Pcs', 120, 10, 'Main Store'),
        ('ING-0011', 'Sugar', 'White granulated sugar', 'Baking', 25, 'Kg', 130, 10, 'Main Store'),
        ('ING-0012', 'Salt', 'Iodized table salt', 'Spices', 10, 'Kg', 50, 5, 'Main Store'),
        ('ING-0013', 'Coriander', 'Fresh coriander leaves', 'Vegetables', 1, 'Kg', 300, 1, 'Main Store'),
        ('ING-0014', 'Ginger', 'Fresh ginger root', 'Spices', 2, 'Kg', 400, 1, 'Main Store'),
        ('ING-0015', 'Garlic', 'Fresh garlic bulbs', 'Spices', 3, 'Kg', 350, 2, 'Main Store')
      ON CONFLICT (sku) DO NOTHING
    `);

    // Seed recipe ingredients (bill of materials) for a few key dishes so
    // automatic stock deduction is demonstrable out of the box. Joins by name
    // to resolve the menu_item / inventory_item UUIDs. Idempotent.
    await client.query(`
      INSERT INTO recipe_ingredients (menu_item_id, inventory_item_id, quantity_per_item)
      SELECT m.id, i.id, r.qty
      FROM (VALUES
        ('Pilau', 'Rice', 0.250),
        ('Pilau', 'Beef', 0.150),
        ('Pilau', 'Cooking Oil', 0.030),
        ('Pilau', 'Pilau Masala', 0.050),
        ('Pilau', 'Onions', 0.050),
        ('Beef Pilau', 'Rice', 0.250),
        ('Beef Pilau', 'Beef', 0.200),
        ('Beef Pilau', 'Cooking Oil', 0.030),
        ('Beef Pilau', 'Pilau Masala', 0.050),
        ('Beef Stew', 'Beef', 0.220),
        ('Beef Stew', 'Onions', 0.060),
        ('Beef Stew', 'Tomatoes', 0.080),
        ('Beef Stew', 'Cooking Oil', 0.020),
        ('Chicken Curry', 'Chicken', 0.250),
        ('Chicken Curry', 'Coconut Milk', 1.000),
        ('Chicken Curry', 'Onions', 0.050),
        ('Ugali', 'Wheat Flour', 0.200),
        ('Chapati', 'Wheat Flour', 0.120),
        ('Chapati', 'Cooking Oil', 0.020),
        ('Tea', 'Milk', 0.150),
        ('Tea', 'Sugar', 0.020),
        ('Coffee', 'Milk', 0.100),
        ('Coffee', 'Sugar', 0.020)
      ) AS r(dish, ingredient, qty)
      JOIN menu_items m ON m.name = r.dish
      JOIN inventory_items i ON i.name = r.ingredient
      ON CONFLICT (menu_item_id, inventory_item_id) DO NOTHING
    `);

    // Seed expense categories
    await client.query(`
      INSERT INTO expense_categories (name, color, budget_limit) VALUES
        ('Purchases', '#3B82F6', 100000),
        ('Salaries', '#8B5CF6', 80000),
        ('Rent', '#10B981', 55000),
        ('Utilities', '#F59E0B', 20000),
        ('Marketing', '#EF4444', 15000),
        ('Supplies', '#6B7280', 10000),
        ('Transport', '#F97316', 5000),
        ('Office', '#14B8A6', 3000)
      ON CONFLICT (name) DO NOTHING
    `);

    // Seed restaurant tables
    await client.query(`
      INSERT INTO restaurant_tables (table_number, area, capacity, status) VALUES
        ('T01', 'Main Hall', 4, 'occupied'),
        ('T02', 'Main Hall', 2, 'available'),
        ('T03', 'Main Hall', 4, 'reserved'),
        ('T04', 'Main Hall', 6, 'available'),
        ('T05', 'Main Hall', 4, 'occupied'),
        ('T06', 'Main Hall', 2, 'available'),
        ('T07', 'Main Hall', 2, 'available'),
        ('T08', 'Main Hall', 6, 'occupied'),
        ('T09', 'Main Hall', 2, 'available'),
        ('T10', 'Main Hall', 4, 'available'),
        ('T11', 'Main Hall', 4, 'reserved'),
        ('T12', 'Main Hall', 2, 'available'),
        ('T13', 'Terrace', 4, 'available'),
        ('T14', 'Terrace', 2, 'available'),
        ('T15', 'Terrace', 6, 'occupied'),
        ('T16', 'Terrace', 4, 'available'),
        ('T17', 'Terrace', 2, 'available'),
        ('T18', 'Terrace', 2, 'available')
      ON CONFLICT (table_number) DO NOTHING
    `);

    // Seed customers
    await client.query(`
      INSERT INTO customers (customer_code, full_name, phone, email, city, tags, is_vip, credit_limit, credit_balance, status) VALUES
        ('CUS-000245', 'John Mwangi', '0712 345 678', 'john.mwangi@gmail.com', 'Nairobi', ARRAY['VIP','Regular','Family','Weekend Customer'], true, 10000, 2450, 'active'),
        ('CUS-000246', 'Mary Akinyi', '0701 234 567', 'mary.akinyi@gmail.com', 'Nairobi', ARRAY['Regular'], false, 5000, 0, 'active'),
        ('CUS-000247', 'Brian Odour', '0723 456 789', 'brian.odour@gmail.com', 'Nairobi', ARRAY['Regular'], false, 5000, 0, 'active'),
        ('CUS-000248', 'Lucy Kamau', '0709 876 543', 'lucy.kamau@gmail.com', 'Nairobi', ARRAY['Regular'], false, 0, 0, 'active'),
        ('CUS-000249', 'Peter Njenga', '0715 678 901', 'peter.njenga@gmail.com', 'Nairobi', ARRAY['Regular'], false, 0, 0, 'inactive'),
        ('CUS-000250', 'Emily Wanjiku', '0704 321 654', 'emily.wanjiku@gmail.com', 'Nairobi', ARRAY['Regular'], false, 0, 0, 'inactive'),
        ('CUS-000251', 'David Mutua', '0720 987 654', 'david.mutua@gmail.com', 'Nairobi', ARRAY['Regular'], false, 0, 0, 'active'),
        ('CUS-000252', 'Sophia Njeri', '0703 654 321', 'sophia.njeri@gmail.com', 'Nairobi', ARRAY['VIP','Regular'], true, 10000, 0, 'active')
      ON CONFLICT (customer_code) DO NOTHING
    `);

    // Seed loyalty rewards
    await client.query(`
      INSERT INTO loyalty_rewards (name, description, points_cost, reward_type, reward_value) VALUES
        ('10% Discount Voucher', 'Get 10% off your next order', 1000, 'discount_voucher', 10),
        ('Free Soda', 'Enjoy a complimentary soda', 300, 'free_item', 120),
        ('Free Dessert', 'Choose any dessert on us', 800, 'free_item', 250),
        ('KES 500 Voucher', 'Cash voucher worth KES 500', 2000, 'cash_voucher', 500)
      ON CONFLICT DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✅ Database seeded successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

seed()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
