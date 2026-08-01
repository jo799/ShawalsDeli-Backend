import { Response } from 'express';
import { query } from '../config/database';
import { AuthRequest, invalidateCustomRoleCache } from '../middleware/auth';
import { logAudit } from '../services/auditLog';
import { PERMISSIONS, ROLES, type Permission } from '../permissions';

// Reserved so a custom role can never collide with (or silently shadow) one
// of the 7 built-in role names.
const isReservedName = (name: string) => (ROLES as readonly string[]).includes(name);

// Turns "Delivery Rider" into "delivery_rider" — this is what actually gets
// stored in users.role, so it needs to survive being embedded in JWTs,
// URLs, and SQL comfortably: lowercase, no spaces or punctuation.
const slugify = (label: string): string =>
  label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);

const validatePermissions = (permissions: unknown): permissions is Permission[] => {
  if (!Array.isArray(permissions)) return false;
  return permissions.every(p => (PERMISSIONS as readonly string[]).includes(p));
};

// GET /roles/custom — every custom role, with how many staff currently
// have it (relevant for the frontend's delete-confirmation and for
// blocking deletion of a role still in use).
export const getCustomRoles = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await query(`
      SELECT cr.*, COUNT(u.id) as staff_count
      FROM custom_roles cr
      LEFT JOIN users u ON u.role = cr.name
      GROUP BY cr.id
      ORDER BY cr.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// POST /roles/custom  { label, permissions: Permission[] }
export const createCustomRole = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { label, permissions } = req.body;

    if (!label || !String(label).trim()) {
      res.status(400).json({ success: false, message: 'A role name is required' });
      return;
    }
    if (!validatePermissions(permissions)) {
      res.status(400).json({ success: false, message: 'permissions must be an array of valid permission strings' });
      return;
    }
    if (permissions.length === 0) {
      res.status(400).json({ success: false, message: 'Pick at least one permission for this role' });
      return;
    }

    const name = slugify(label);
    if (!name) { res.status(400).json({ success: false, message: 'That role name could not be turned into a valid identifier — try adding some letters' }); return; }
    if (isReservedName(name)) { res.status(400).json({ success: false, message: `"${label}" is too close to a built-in role name — try something more specific` }); return; }

    const existing = await query('SELECT id FROM custom_roles WHERE name = $1', [name]);
    if (existing.rows.length > 0) { res.status(409).json({ success: false, message: `A role named "${label}" already exists` }); return; }

    const result = await query(
      `INSERT INTO custom_roles (name, label, permissions, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, String(label).trim(), JSON.stringify(permissions), req.user!.id]
    );

    await logAudit(req, { action: 'custom_role_created', entityType: 'custom_role', entityId: result.rows[0].id, details: { label, permissions } });

    invalidateCustomRoleCache();
    res.status(201).json({ success: true, data: { ...result.rows[0], staff_count: 0 } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PUT /roles/custom/:id  { label?, permissions? }
//
// Renaming a role does NOT change its stored `name`/slug — every user
// currently assigned this role references it by that slug, and silently
// changing it would orphan them all. Only the display label and the
// permission set can be edited after creation; picking a genuinely
// different identity means creating a new role instead.
export const updateCustomRole = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { label, permissions } = req.body;

    const existing = await query('SELECT * FROM custom_roles WHERE id = $1', [id]);
    if (!existing.rows.length) { res.status(404).json({ success: false, message: 'Role not found' }); return; }

    if (permissions !== undefined) {
      if (!validatePermissions(permissions)) { res.status(400).json({ success: false, message: 'permissions must be an array of valid permission strings' }); return; }
      if (permissions.length === 0) { res.status(400).json({ success: false, message: 'A role needs at least one permission' }); return; }
    }
    if (label !== undefined && !String(label).trim()) {
      res.status(400).json({ success: false, message: 'Role name cannot be empty' });
      return;
    }

    const result = await query(
      `UPDATE custom_roles SET label = COALESCE($1, label), permissions = COALESCE($2, permissions), updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING *`,
      [label ? String(label).trim() : null, permissions ? JSON.stringify(permissions) : null, id]
    );

    await logAudit(req, { action: 'custom_role_updated', entityType: 'custom_role', entityId: id, details: { label, permissions } });

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// DELETE /roles/custom/:id
//
// Blocked while any staff member currently has this role — deleting it out
// from under them would leave their account with a role that resolves to
// zero permissions everywhere, effectively locking them out silently.
export const deleteCustomRole = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const existing = await query('SELECT * FROM custom_roles WHERE id = $1', [id]);
    if (!existing.rows.length) { res.status(404).json({ success: false, message: 'Role not found' }); return; }

    const inUse = await query('SELECT COUNT(*) as c FROM users WHERE role = $1', [existing.rows[0].name]);
    if (parseInt(inUse.rows[0].c) > 0) {
      res.status(400).json({ success: false, message: `${inUse.rows[0].c} staff member(s) currently have this role — reassign them first.` });
      return;
    }

    await query('DELETE FROM custom_roles WHERE id = $1', [id]);
    await logAudit(req, { action: 'custom_role_deleted', entityType: 'custom_role', entityId: id, details: { label: existing.rows[0].label } });
    invalidateCustomRoleCache();
    res.json({ success: true, message: 'Role deleted' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};