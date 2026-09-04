// Standalone copy of the permissions/roles definitions. This used to be
// synced automatically from a shared/ folder one level above this repo
// (back when backend and frontend lived in the same monorepo) — now that
// this is its own separate repository, that shared folder doesn't exist in
// this codebase's context at all, so this file is the real, hand-edited
// source of truth for the backend specifically. If the frontend's copy of
// this file (frontend's shared/permissions.ts) ever changes — a new role,
// a new permission — this file needs the same change made here manually;
// there's no longer an automatic sync between them.
export const ROLES = [
  'administrator',
  'manager',
  'head_chef',
  'cashier',
  'waiter',
  'kitchen_staff',
  'cleaner',
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard.view',
  'pos.view',
  'pos.manage',
  'orders.view',
  'orders.manage',
  'orders.refund',
  'kitchen.view',
  'kitchen.manage',
  'tables.view',
  'tables.manage',
  'menu.view',
  'menu.manage',
  'menu.adjust_stock',
  'inventory.view',
  'inventory.manage',
  'inventory.adjust',
  'purchases.view',
  'purchases.manage',
  'customers.view',
  'customers.manage',
  'loyalty.view',
  'loyalty.manage',
  'reports.view',
  'expenses.view',
  'expenses.manage',
  'staff.view',
  'staff.manage',
  'scheduling.view',
  'scheduling.manage',
  'settings.view',
  'settings.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_LABELS: Record<Role, string> = {
  administrator: 'Administrator',
  manager: 'Manager',
  head_chef: 'Head Chef',
  cashier: 'Cashier',
  waiter: 'Waiter',
  kitchen_staff: 'Kitchen Staff',
  cleaner: 'Cleaner',
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  'dashboard.view': 'Dashboard',
  'pos.view': 'POS',
  'pos.manage': 'POS (Manage)',
  'orders.view': 'Orders',
  'orders.manage': 'Orders (Manage)',
  'orders.refund': 'Orders (Refund)',
  'kitchen.view': 'Kitchen',
  'kitchen.manage': 'Kitchen (Manage)',
  'tables.view': 'Tables',
  'tables.manage': 'Tables (Manage)',
  'menu.view': 'Menu',
  'menu.manage': 'Menu (Manage)',
  'menu.adjust_stock': 'Menu (Adjust Stock)',
  'inventory.view': 'Inventory',
  'inventory.manage': 'Inventory (Manage)',
  'inventory.adjust': 'Inventory (Adjust)',
  'purchases.view': 'Purchases',
  'purchases.manage': 'Purchases (Manage)',
  'customers.view': 'Customers',
  'customers.manage': 'Customers (Manage)',
  'loyalty.view': 'Loyalty',
  'loyalty.manage': 'Loyalty (Manage)',
  'reports.view': 'Reports',
  'expenses.view': 'Expenses',
  'expenses.manage': 'Expenses (Manage)',
  'staff.view': 'Staff',
  'staff.manage': 'Staff (Manage)',
  'scheduling.view': 'Scheduling',
  'scheduling.manage': 'Scheduling (Manage)',
  'settings.view': 'Settings',
  'settings.manage': 'Settings (Manage)',
};

/** Module-level permissions shown in the Settings read-only matrix. */
export const MATRIX_MODULES: { key: Permission; label: string }[] = [
  { key: 'dashboard.view', label: 'Dashboard' },
  { key: 'pos.manage', label: 'POS' },
  { key: 'orders.manage', label: 'Orders' },
  { key: 'kitchen.manage', label: 'Kitchen' },
  { key: 'tables.manage', label: 'Tables' },
  { key: 'menu.manage', label: 'Menu' },
  { key: 'inventory.manage', label: 'Inventory' },
  { key: 'purchases.manage', label: 'Purchases' },
  { key: 'customers.manage', label: 'Customers' },
  { key: 'loyalty.manage', label: 'Loyalty' },
  { key: 'reports.view', label: 'Reports' },
  { key: 'expenses.manage', label: 'Expenses' },
  { key: 'staff.manage', label: 'Staff' },
  { key: 'scheduling.view', label: 'Scheduling' },
  { key: 'settings.manage', label: 'Settings' },
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  administrator: [...PERMISSIONS],
  manager: [...PERMISSIONS],
  head_chef: [
    'dashboard.view',
    'orders.view',
    'orders.manage',
    'kitchen.view',
    'kitchen.manage',
    'tables.view',
    'menu.view',
    'menu.manage',
    'menu.adjust_stock',
    'inventory.view',
    'scheduling.view',
  ],
  cashier: [
    'dashboard.view',
    'pos.view',
    'pos.manage',
    'orders.view',
    'orders.manage',
    'tables.view',
    'tables.manage',
    'menu.view',
    'menu.manage',
    'menu.adjust_stock',
    'inventory.view',
    'customers.view',
    'customers.manage',
    'loyalty.view',
    'loyalty.manage',
    'scheduling.view',
  ],
  waiter: [
    'dashboard.view',
    'pos.view',
    'pos.manage',
    'orders.view',
    'orders.manage',
    'tables.view',
    'tables.manage',
    'menu.view',
    'customers.view',
    'customers.manage',
    'loyalty.view',
    'scheduling.view',
  ],
  kitchen_staff: [
    'orders.view',
    'kitchen.view',
    'kitchen.manage',
    'menu.view',
    'inventory.view',
    'scheduling.view',
  ],
  cleaner: [
    'dashboard.view',
    'scheduling.view',
  ],
};

/** Route path → minimum permission required to access the page. */
export const ROUTE_PERMISSIONS: Record<string, Permission> = {
  '/': 'dashboard.view',
  '/pos': 'pos.view',
  '/orders': 'orders.view',
  '/kitchen': 'kitchen.view',
  '/tables': 'tables.view',
  '/menu': 'menu.view',
  '/inventory': 'inventory.view',
  '/purchases': 'purchases.view',
  '/customers': 'customers.view',
  '/loyalty': 'loyalty.view',
  '/credits': 'customers.view',
  '/reports': 'reports.view',
  '/expenses': 'expenses.view',
  '/staff': 'staff.view',
  '/scheduling': 'scheduling.view',
  '/settings': 'settings.view',
};

export const USER_STATUSES = ['active', 'inactive', 'on_leave'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export function isValidRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

export function isValidStatus(status: string): status is UserStatus {
  return (USER_STATUSES as readonly string[]).includes(status);
}

// Every built-in role that grants a module-level permission beyond plain
// viewing (e.g. cashier's 'pos.manage') also explicitly grants that
// module's '.view' permission — you can't sensibly manage something you
// can't see. Custom roles built through the "What can this role access?"
// checklist in Manage Roles don't get that pairing for free: MATRIX_MODULES
// deliberately shows one representative checkbox per module (often the
// '.manage' variant, so the label reads "Orders" rather than "Orders
// (View)"), and checking it stores only that single permission. Since
// every route guard (ROUTE_PERMISSIONS) checks specifically for '.view',
// a role holding only 'orders.manage' can manage orders on paper but can't
// actually reach the Orders page or see its sidebar link — the module
// silently vanishes from their nav. This normalizes any permission list so
// a module-level permission always implies that module's view permission,
// closing that gap for every role, not just ones built a particular way.
export function expandImpliedPermissions(permissions: Permission[]): Permission[] {
  const expanded = new Set<Permission>(permissions);
  for (const p of permissions) {
    const module = p.split('.')[0];
    const viewPerm = `${module}.view` as Permission;
    if ((PERMISSIONS as readonly string[]).includes(viewPerm)) expanded.add(viewPerm);
  }
  return Array.from(expanded);
}

export function getPermissionsForRole(role: string): Permission[] {
  if (!isValidRole(role)) return [];
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(role: string | undefined | null, permission: Permission): boolean {
  if (!role || !isValidRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function hasAnyPermission(role: string | undefined | null, permissions: Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

export function canAccessRoute(role: string | undefined | null, path: string): boolean {
  const permission = ROUTE_PERMISSIONS[path];
  if (!permission) return true;
  return hasPermission(role, permission);
}

export function getDefaultRouteForRole(role: string | undefined | null): string {
  const priority = ['/', '/pos', '/kitchen', '/orders', '/scheduling', '/tables', '/menu'];
  for (const path of priority) {
    if (canAccessRoute(role, path)) return path;
  }
  return '/login';
}

export function roleHasModuleAccess(role: Role, moduleKey: Permission): boolean {
  return hasPermission(role, moduleKey);
}