import { Router } from 'express';
import { login, register, forgotPassword, verifyResetOtp, resetPassword, getProfile, changePassword, verifyLoginOtp, getSystemStatus, setupFirstAdmin } from '../controllers/authController';
import { getOrders, getOrderById, createOrder, updateOrderStatus, processPayment, cancelPendingPayment, refundOrder, voidOrder, getOrderStats, requestRefund, getRefundRequests, approveRefundRequest, declineRefundRequest, assignOrderToChef } from '../controllers/ordersController';
import { getMenuItems, getCategories, createCategory, updateCategory, deleteCategory, createMenuItem, updateMenuItem, deleteMenuItem, getRecipe, setRecipe, getMenuItemByBarcode } from '../controllers/menuController';
import { uploadMenuImage } from '../controllers/uploadController';
import { getInventory, adjustStock, createInventoryItem, updateInventoryItem, deleteInventoryItem, getInventoryActivity, getLowStock } from '../controllers/inventoryController';
import { getCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, redeemPoints, adjustPoints } from '../controllers/customersController';
import { getLoyaltyStats, getLoyaltyTiers, updatePointValue } from '../controllers/loyaltyController';
import { getDailyReport, getSummaryReport } from '../controllers/reportsController';
import { exportSalesReport } from '../controllers/salesReportController';
import { getExpenses, getExpenseStats, createExpense, updateExpense, deleteExpense, getExpenseCategories, createExpenseCategory, uploadExpenseReceipt } from '../controllers/expensesController';
import { getStaff, createStaff, updateStaff, setApprovalStatus, resetStaffPassword, getSchedules, upsertSchedule, deleteSchedule } from '../controllers/staffController';
import { getTables, updateTableStatus, createTable, updateTable, deleteTable, getReservations, createReservation, updateReservationStatus } from '../controllers/tablesController';
import { getPurchaseOrders, getPurchaseOrderById, createPurchaseOrder, receivePurchaseOrder, getSuppliers, createSupplier } from '../controllers/purchasesController';
import { initiateStkPush, queryStkStatus, mpesaCallback, reconcilePayment } from '../controllers/mpesaController';
import { createHeldOrder, getHeldOrders, deleteHeldOrder } from '../controllers/heldOrdersController';
import { getSettings, updateSettings, uploadLogo, getSystemInfo, getStorageUsage, createBackup, getBackups, downloadBackup, getRecentActivity } from '../controllers/settingsController';
import { getAuditLogs, getAuditLogActions } from '../controllers/auditLogsController';
import { getPushConfig, subscribe, unsubscribe } from '../controllers/pushController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// Auth
router.get('/auth/system-status', getSystemStatus);
router.post('/auth/setup', setupFirstAdmin);
router.post('/auth/login', login);
router.post('/auth/verify-otp', verifyLoginOtp);
router.post('/auth/register', register);
router.post('/auth/forgot-password', forgotPassword);
router.post('/auth/verify-reset-otp', verifyResetOtp);
router.post('/auth/reset-password', resetPassword);
router.get('/auth/profile', authenticate, getProfile);
router.put('/auth/change-password', authenticate, changePassword);

// Orders
router.get('/orders', authenticate, getOrders);
// Must come before /orders/:id — otherwise Express matches "stats" as an :id
// and this route is never reached.
router.get('/orders/stats/active', authenticate, getOrderStats);
router.get('/orders/:id', authenticate, getOrderById);
router.post('/orders', authenticate, createOrder);
router.put('/orders/:id/status', authenticate, updateOrderStatus);
router.post('/orders/:id/payment', authenticate, processPayment);
router.post('/orders/:id/cancel-payment', authenticate, cancelPendingPayment);
// Returning money and voiding paid orders directly is an administrator-only
// action now — they're the approval authority for the refund-request
// workflow below, so there's no one left to check an admin doing this
// directly. Managers and cashiers submit a request instead (see
// requestRefund) — no money moves until an admin explicitly approves it,
// so there's no added risk in letting whoever's actually facing the
// customer kick one off.
router.post('/orders/:id/refund', authenticate, authorize('administrator'), refundOrder);
router.post('/orders/:id/void', authenticate, authorize('administrator'), voidOrder);
router.post('/orders/:id/refund-request', authenticate, authorize('administrator', 'manager', 'cashier'), requestRefund);
router.get('/refund-requests', authenticate, authorize('administrator'), getRefundRequests);
router.post('/refund-requests/:id/approve', authenticate, authorize('administrator'), approveRefundRequest);
router.post('/refund-requests/:id/decline', authenticate, authorize('administrator'), declineRefundRequest);
router.post('/orders/:id/assign-chef', authenticate, authorize('administrator'), assignOrderToChef);

// Menu
router.get('/menu/items', authenticate, getMenuItems);
router.get('/menu/categories', authenticate, getCategories);
router.post('/menu/categories', authenticate, authorize('administrator', 'manager'), createCategory);
router.put('/menu/categories/:id', authenticate, authorize('administrator', 'manager'), updateCategory);
router.delete('/menu/categories/:id', authenticate, authorize('administrator', 'manager'), deleteCategory);
router.post('/menu/items', authenticate, authorize('administrator', 'manager'), createMenuItem);
router.post('/menu/upload', authenticate, authorize('administrator', 'manager'), uploadMenuImage);
router.put('/menu/items/:id', authenticate, authorize('administrator', 'manager'), updateMenuItem);
router.delete('/menu/items/:id', authenticate, authorize('administrator', 'manager'), deleteMenuItem);
router.get('/menu/items/:id/recipe', authenticate, getRecipe);
router.get('/menu/items/barcode/:code', authenticate, getMenuItemByBarcode);
router.put('/menu/items/:id/recipe', authenticate, authorize('administrator', 'manager'), setRecipe);

// Inventory
router.get('/inventory', authenticate, getInventory);
router.get('/inventory/low-stock', authenticate, getLowStock);
router.post('/inventory', authenticate, authorize('administrator', 'manager'), createInventoryItem);
router.put('/inventory/:id', authenticate, authorize('administrator', 'manager'), updateInventoryItem);
router.delete('/inventory/:id', authenticate, authorize('administrator', 'manager'), deleteInventoryItem);
router.post('/inventory/:id/adjust', authenticate, adjustStock);
router.get('/inventory/activity', authenticate, getInventoryActivity);

// Customers
router.get('/customers', authenticate, getCustomers);
router.get('/customers/:id', authenticate, getCustomerById);
router.post('/customers', authenticate, createCustomer);
router.put('/customers/:id', authenticate, updateCustomer);
router.post('/customers/:id/redeem-points', authenticate, redeemPoints);
router.post('/customers/:id/adjust-points', authenticate, authorize('administrator', 'manager'), adjustPoints);
router.delete('/customers/:id', authenticate, authorize('administrator', 'manager'), deleteCustomer);
router.get('/loyalty/stats', authenticate, getLoyaltyStats);
router.get('/loyalty/tiers', authenticate, getLoyaltyTiers);
router.put('/loyalty/point-value', authenticate, authorize('administrator', 'manager'), updatePointValue);

// Reports
router.get('/reports/daily', authenticate, getDailyReport);
router.get('/reports/summary', authenticate, getSummaryReport);
router.get('/reports/sales-export', authenticate, exportSalesReport);

// Expenses
router.get('/expenses', authenticate, getExpenses);
router.get('/expenses/stats', authenticate, getExpenseStats);
router.get('/expenses/categories', authenticate, getExpenseCategories);
router.post('/expenses/categories', authenticate, authorize('administrator', 'manager'), createExpenseCategory);
// Expenses are financial records that affect real reporting — same
// admin/manager restriction as deleting one already had, now applied
// consistently to creating and editing them too. Previously any
// authenticated staff member (a waiter, a cleaner) could create or modify
// an expense record with no restriction at all.
router.post('/expenses', authenticate, authorize('administrator', 'manager'), createExpense);
router.put('/expenses/:id', authenticate, authorize('administrator', 'manager'), updateExpense);
router.post('/expenses/:id/receipt', authenticate, authorize('administrator', 'manager'), uploadExpenseReceipt);
router.delete('/expenses/:id', authenticate, authorize('administrator', 'manager'), deleteExpense);

// Staff
router.get('/staff', authenticate, authorize('administrator', 'manager'), getStaff);
router.post('/staff', authenticate, authorize('administrator', 'manager'), createStaff);
router.put('/staff/:id', authenticate, authorize('administrator', 'manager'), updateStaff);
router.put('/staff/:id/reset-password', authenticate, authorize('administrator', 'manager'), resetStaffPassword);
router.put('/staff/:id/approval', authenticate, authorize('administrator', 'manager'), setApprovalStatus);
router.get('/staff/schedules', authenticate, getSchedules);
router.post('/staff/schedules', authenticate, authorize('administrator', 'manager'), upsertSchedule);
router.delete('/staff/schedules/:user_id/:shift_date', authenticate, authorize('administrator', 'manager'), deleteSchedule);

// Tables
router.get('/tables', authenticate, getTables);
router.put('/tables/:id/status', authenticate, updateTableStatus);
// Adding/editing/removing tables is floor-plan configuration, not routine
// service — same admin/manager restriction as menu management.
router.post('/tables', authenticate, authorize('administrator', 'manager'), createTable);
router.put('/tables/:id', authenticate, authorize('administrator', 'manager'), updateTable);
router.delete('/tables/:id', authenticate, authorize('administrator', 'manager'), deleteTable);
router.get('/tables/reservations', authenticate, getReservations);
router.post('/tables/reservations', authenticate, createReservation);
// Seating/cancelling/completing a reservation is routine floor operations —
// same "any authenticated staff" access as updateTableStatus, not restricted
// to admin/manager like adding/removing tables is.
router.put('/tables/reservations/:id/status', authenticate, updateReservationStatus);

// Held Orders (POS "Hold Order" / "Save Draft") — any authenticated staff
// member can park or resume a cart; no admin restriction needed for a
// routine POS action.
router.get('/held-orders', authenticate, getHeldOrders);
router.post('/held-orders', authenticate, createHeldOrder);
router.delete('/held-orders/:id', authenticate, deleteHeldOrder);

// Purchases
router.get('/purchases', authenticate, getPurchaseOrders);
router.get('/purchases/:id', authenticate, getPurchaseOrderById);
router.post('/purchases', authenticate, authorize('administrator', 'manager'), createPurchaseOrder);
// Receiving a delivery is routine floor/stockroom operation, same level as
// adjustStock — not restricted to admin/manager the way creating a new PO is.
router.put('/purchases/:id/receive', authenticate, receivePurchaseOrder);
router.get('/suppliers', authenticate, getSuppliers);
router.post('/suppliers', authenticate, authorize('administrator', 'manager'), createSupplier);

// M-Pesa
router.post('/mpesa/stk-push', authenticate, initiateStkPush);
router.get('/mpesa/status/:checkout_request_id', authenticate, queryStkStatus);
router.post('/mpesa/reconcile/:checkout_request_id', authenticate, reconcilePayment);
router.post('/mpesa/callback', mpesaCallback); // No auth — called by Safaricom servers
// Alias: the README (and anyone who configured Safaricom's Daraja portal
// from it before this fix) references /api/payments/mpesa/callback. Keep
// both live so existing callback URL configs don't silently break.
router.post('/payments/mpesa/callback', mpesaCallback); // No auth — called by Safaricom servers

// Settings — General/Business Profile viewable by any authenticated staff
// (e.g. business name/logo shown elsewhere in the app), editable only by
// admin/manager. System info, storage, and backups are more sensitive
// (infra + a complete data export) and restricted further where noted below.
router.get('/settings', authenticate, getSettings);
router.put('/settings', authenticate, authorize('administrator', 'manager'), updateSettings);
router.post('/settings/logo', authenticate, authorize('administrator', 'manager'), uploadLogo);
router.get('/settings/system-info', authenticate, authorize('administrator', 'manager'), getSystemInfo);
router.get('/settings/storage-usage', authenticate, authorize('administrator', 'manager'), getStorageUsage);
router.get('/settings/recent-activity', authenticate, authorize('administrator', 'manager'), getRecentActivity);
// Backups contain every order, payment, and customer record the business
// has — restricted to administrator only, one level tighter than the rest
// of Settings (manager cannot create/list/download them).
router.post('/settings/backup', authenticate, authorize('administrator'), createBackup);
router.get('/settings/backups', authenticate, authorize('administrator'), getBackups);
router.get('/settings/backups/:filename', authenticate, authorize('administrator'), downloadBackup);

// Audit Logs — admin-only, same reasoning as backups: this is visibility
// into everyone's actions across the whole system, not something a
// manager-level view should include.
router.get('/audit-logs', authenticate, authorize('administrator'), getAuditLogs);
router.get('/audit-logs/actions', authenticate, authorize('administrator'), getAuditLogActions);

// Push notifications — any authenticated user can subscribe/unsubscribe
// their own device; only kitchen-relevant roles actually get notified (see
// pushService.notifyKitchenOfNewOrder), but there's no reason to lock this
// down further than "you can manage your own device's subscription".
router.get('/push/config', authenticate, getPushConfig);
router.post('/push/subscribe', authenticate, subscribe);
router.post('/push/unsubscribe', authenticate, unsubscribe);

export default router;