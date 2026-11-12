import { z } from "zod";

import { createCredentials } from "../security/credentials";
import { normalizePhone } from "./customers";
import {
  type Clock,
  id,
  nonnegativeInteger,
  opaqueId,
  timestamp,
  utcTimestamp,
} from "./values";

export interface Employee {
  id: string;
  name: string;
  phoneNumber?: string;
  /** Sign-in address of the employee web app, lower-cased. */
  email: string | null;
  /** Browsers currently signed in to the employee web app. */
  webSessions: number;
  /** Another active employee has the same phone number (WhatsApp sign-in by phone would be ambiguous). */
  phoneShared: boolean;
  active: boolean;
  createdAt: string;
}

export interface Device {
  id: string;
  employeeId: string;
  invitationId?: string;
  lastInvitationId?: string;
  phoneNumbers: string[];
  phoneNumbersReportedAt?: string;
  assignedAt: string;
  model?: string;
  manufacturer?: string;
  androidVersion?: string;
  oneUiVersion?: string;
  appVersion?: string;
  pendingUploads?: number;
  lastSuccessfulUploadAt?: string;
  lastSeenAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export interface Invitation {
  id: string;
  employeeId: string;
  purpose: "enrollment" | "recovery";
  deviceId?: string;
  recoveryDeviceId?: string;
  expiresAt: string;
  revokedAt?: string;
  redeemedAt?: string;
  createdAt: string;
}

export type ManagedDevice = Device & {
  employee: Pick<Employee, "id" | "name">;
};
export type InvitationSummary = Invitation & {
  status: "active" | "redeemed" | "expired" | "revoked";
};
export const directoryCursor = z.strictObject({ sortAt: utcTimestamp, id });
export const phoneNumbersInput = z
  .array(z.string().trim().min(1).max(64))
  .max(8);
const directoryInput = z.object({
  cursor: directoryCursor.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
type DirectoryInput = z.input<typeof directoryInput>;
type DirectoryPage<T> = {
  items: T[];
  nextCursor: z.infer<typeof directoryCursor> | null;
};

function directoryPage<Row extends { id: string; created_at: string }, Item>(
  rows: Row[],
  limit: number,
  map: (row: Row) => Item,
): DirectoryPage<Item> {
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  return {
    items: rows.map(map),
    nextCursor:
      hasMore && last ? { sortAt: last.created_at, id: last.id } : null,
  };
}

/** Contact number shown to customers through WhatsApp templates; stored as "+<country code><digits>". */
const employeePhone = z.string().trim().min(1).max(64).transform((value, context) => {
  const normalized = normalizePhone(value);
  if (!normalized) {
    context.addIssue({ code: "custom", message: "Invalid phone number" });
    return z.NEVER;
  }
  return normalized.phone;
});
/** The sign-in address of the employee web app: trimmed, validated and lower-cased. */
const employeeEmail = z.string().trim().max(254).pipe(z.email()).transform((value) => value.toLowerCase());
export function normalizeEmail(value: string): string | null {
  const parsed = employeeEmail.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Another employee already signs in with this address. */
export class EmployeeEmailExistsError extends Error {
  constructor() { super("An employee with this email already exists"); }
}

/** Another active employee already has this phone number. */
export class EmployeePhoneExistsError extends Error {
  constructor() { super("Another active employee already has this phone number"); }
}

const employeeInput = z.object({
  name: z.string().trim().min(1).max(200),
  phoneNumber: employeePhone.optional(),
  email: employeeEmail.nullable().optional(),
});
const employeeUpdateInput = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  phoneNumber: employeePhone.nullable().optional(),
  email: employeeEmail.nullable().optional(),
}).refine((value) => value.name !== undefined || value.phoneNumber !== undefined || value.email !== undefined, { message: "Nothing to update" });
const deviceInput = z.object({
  model: z.string().optional(),
  manufacturer: z.string().optional(),
  androidVersion: z.string().optional(),
  oneUiVersion: z.string().optional(),
  appVersion: z.string().optional(),
  phoneNumbers: phoneNumbersInput.optional(),
});
const heartbeatInput = z.object({
  appVersion: z.string(),
  pendingUploads: nonnegativeInteger,
  lastSuccessfulUploadAt: utcTimestamp.optional(),
  deviceId: id.optional(),
  phoneNumbers: phoneNumbersInput.optional(),
});

export interface IdentityRepository {
  getEmployee(employeeId: string): Promise<Employee | null>;
  getDevice(deviceId: string): Promise<Device | null>;
  listEmployees(input?: DirectoryInput): Promise<DirectoryPage<Employee>>;
  updateEmployee(
    employeeId: string,
    input: { name?: string; phoneNumber?: string | null; email?: string | null },
  ): Promise<Employee | null>;
  getManagedDevice(deviceId: string): Promise<ManagedDevice | null>;
  listDevices(
    input?: DirectoryInput & { employeeId?: string; includeRevoked?: boolean },
  ): Promise<DirectoryPage<ManagedDevice>>;
  reassignDevice(
    deviceId: string,
    employeeId: string,
  ): Promise<ManagedDevice | null>;
  listInvitations(
    employeeId: string,
    input?: DirectoryInput & { includeRevoked?: boolean },
  ): Promise<DirectoryPage<InvitationSummary>>;
  revokeInvitation(
    employeeId: string,
    invitationId: string,
  ): Promise<InvitationSummary | null>;
  createEmployee(input: z.input<typeof employeeInput>): Promise<Employee>;
  setEmployeeActive(
    employeeId: string,
    active: boolean,
  ): Promise<Employee | null>;
  /** Signs the employee out of every browser; returns how many sessions ended. */
  revokeWebSessions(employeeId: string): Promise<number>;
  createInvitation(
    employeeId: string,
    expiresAt: string,
  ): Promise<(Invitation & { invitationCode: string }) | null>;
  createRecoveryInvitation(
    deviceId: string,
    expiresAt: string,
  ): Promise<(Invitation & { invitationCode: string }) | null>;
  getInvitation(invitationId: string): Promise<Invitation | null>;
  redeemInvitation(
    invitationCode: string,
    input: z.input<typeof deviceInput>,
  ): Promise<{
    device: Device;
    employee: Pick<Employee, "id" | "name">;
    deviceToken: string;
  } | null>;
  authenticateDevice(token: string): Promise<Device | null>;
  revokeDevice(deviceId: string): Promise<Device | null>;
  recordHeartbeat(
    deviceId: string,
    input: z.input<typeof heartbeatInput>,
  ): Promise<ManagedDevice | null>;
}

type EmployeeRow = {
  id: string;
  name: string;
  phone_number: string | null;
  email: string | null;
  web_sessions: number;
  phone_shared: number;
  active: number;
  created_at: string;
};
type InvitationRow = {
  id: string;
  employee_id: string;
  purpose: Invitation["purpose"];
  device_id: string | null;
  recovery_device_id: string | null;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  created_at: string;
};
type DeviceRow = {
  id: string;
  employee_id: string;
  invitation_id: string | null;
  last_invitation_id: string | null;
  phone_numbers: string;
  phone_numbers_reported_at: string | null;
  assigned_at: string;
  model: string | null;
  manufacturer: string | null;
  android_version: string | null;
  one_ui_version: string | null;
  app_version: string | null;
  pending_uploads: number | null;
  last_successful_upload_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

/** Live sessions are counted in SQL against the same clock the sessions are issued with (UTC, millisecond ISO). */
const employeeColumns = `id, name, phone_number, email, active, created_at,
  (SELECT count(*) FROM web_sessions s WHERE s.employee_id = employees.id
    AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND s.idle_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS web_sessions,
  (employees.active = 1 AND employees.phone_number IS NOT NULL AND EXISTS (SELECT 1 FROM employees o
    WHERE o.active = 1 AND o.id <> employees.id AND o.phone_number IS NOT NULL
      AND substr(replace(o.phone_number, '+', ''), -10) = substr(replace(employees.phone_number, '+', ''), -10))) AS phone_shared`;
const invitationColumns =
  "id, employee_id, expires_at, redeemed_at, revoked_at, created_at, purpose, device_id, recovery_device_id";
const deviceColumns = `id, employee_id, model, manufacturer, android_version, one_ui_version,
  app_version, pending_uploads, last_successful_upload_at, last_seen_at, revoked_at, created_at,
  phone_numbers, phone_numbers_reported_at, assigned_at, invitation_id, last_invitation_id`;
const managedDeviceColumns = `${deviceColumns},
  (SELECT name FROM employees WHERE id = devices.employee_id) AS employee_name`;

function employee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    name: row.name,
    phoneNumber: row.phone_number ?? undefined,
    email: row.email,
    webSessions: row.web_sessions,
    phoneShared: row.phone_shared === 1,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}
function emailConflict(error: unknown): unknown {
  return error instanceof Error && /UNIQUE constraint failed.*email|employees_email_idx/i.test(error.message)
    ? new EmployeeEmailExistsError() : error;
}

/** Phone numbers are stored as "+<digits>"; the last ten digits are the key everything else matches on. */
const phoneKeyOf = (phone: string) => phone.replace(/\D/g, "").slice(-10);

async function assertPhoneFree(db: D1Database, phone: string, exceptEmployeeId: string): Promise<void> {
  const clash = await db.prepare(
    `SELECT 1 AS clash FROM employees WHERE active = 1 AND id <> ? AND phone_number IS NOT NULL
      AND substr(replace(phone_number, '+', ''), -10) = ?`,
  ).bind(exceptEmployeeId, phoneKeyOf(phone)).first();
  if (clash) throw new EmployeePhoneExistsError();
}
function invitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    employeeId: row.employee_id,
    purpose: row.purpose,
    deviceId: row.device_id ?? undefined,
    recoveryDeviceId: row.recovery_device_id ?? undefined,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    createdAt: row.created_at,
  };
}
function device(row: DeviceRow): Device {
  return {
    id: row.id,
    employeeId: row.employee_id,
    invitationId: row.invitation_id ?? undefined,
    lastInvitationId: row.last_invitation_id ?? undefined,
    phoneNumbers: JSON.parse(row.phone_numbers),
    phoneNumbersReportedAt: row.phone_numbers_reported_at ?? undefined,
    assignedAt: row.assigned_at,
    model: row.model ?? undefined,
    manufacturer: row.manufacturer ?? undefined,
    androidVersion: row.android_version ?? undefined,
    oneUiVersion: row.one_ui_version ?? undefined,
    appVersion: row.app_version ?? undefined,
    pendingUploads: row.pending_uploads ?? undefined,
    lastSuccessfulUploadAt: row.last_successful_upload_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    createdAt: row.created_at,
  };
}

function managedDevice(
  row: DeviceRow & { employee_name: string },
): ManagedDevice {
  return {
    ...device(row),
    employee: { id: row.employee_id, name: row.employee_name },
  };
}

/** SQL and credential hashes stay behind this boundary, including registration's transaction. */
export function createIdentityRepository(
  db: D1Database,
  tokenHashSecret: string,
  clock: Clock = () => new Date(),
): IdentityRepository {
  const credentials = createCredentials(tokenHashSecret);

  async function getEmployee(employeeId: string): Promise<Employee | null> {
    const row = await db
      .prepare(`SELECT ${employeeColumns} FROM employees WHERE id = ?`)
      .bind(id.parse(employeeId))
      .first<EmployeeRow>();
    return row ? employee(row) : null;
  }

  async function getDevice(deviceId: string): Promise<Device | null> {
    const row = await db
      .prepare(`SELECT ${deviceColumns} FROM devices WHERE id = ?`)
      .bind(id.parse(deviceId))
      .first<DeviceRow>();
    return row ? device(row) : null;
  }

  function invitationSummary(row: InvitationRow): InvitationSummary {
    return {
      ...invitation(row),
      status: row.redeemed_at
        ? "redeemed"
        : row.revoked_at
          ? "revoked"
          : row.expires_at <= timestamp(clock)
            ? "expired"
            : "active",
    };
  }

  async function getManagedDevice(
    deviceId: string,
  ): Promise<ManagedDevice | null> {
    const row = await db
      .prepare(`SELECT ${managedDeviceColumns} FROM devices WHERE id = ?`)
      .bind(id.parse(deviceId))
      .first<DeviceRow & { employee_name: string }>();
    return row ? managedDevice(row) : null;
  }

  return {
    getEmployee,
    getDevice,
    getManagedDevice,

    async listEmployees(input = {}) {
      const value = directoryInput.parse(input);
      const rows = await db
        .prepare(
          `SELECT ${employeeColumns} FROM employees
        ${value.cursor ? "WHERE (created_at, id) < (?, ?)" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .bind(
          ...(value.cursor ? [value.cursor.sortAt, value.cursor.id] : []),
          value.limit + 1,
        )
        .all<EmployeeRow>();
      return directoryPage(rows.results, value.limit, employee);
    },

    /** Changing or clearing the sign-in email also signs the employee out of every browser. */
    async updateEmployee(employeeId, input) {
      const value = employeeUpdateInput.parse(input);
      const key = id.parse(employeeId);
      if (value.phoneNumber) {
        // Only a changed number is checked, so editing a name never fails because of older shared numbers.
        const current = await db.prepare("SELECT phone_number FROM employees WHERE id = ?").bind(key).first<{ phone_number: string | null }>();
        if (!current?.phone_number || phoneKeyOf(current.phone_number) !== phoneKeyOf(value.phoneNumber)) {
          await assertPhoneFree(db, value.phoneNumber, key);
        }
      }
      try {
        const [, updated] = await db.batch<EmployeeRow>([
          db.prepare(
            `DELETE FROM web_sessions WHERE employee_id = ?1 AND ?2 = 1
              AND NOT EXISTS (SELECT 1 FROM employees WHERE id = ?1 AND email IS ?3)`,
          ).bind(key, value.email === undefined ? 0 : 1, value.email ?? null),
          db.prepare(
            `UPDATE employees SET name = COALESCE(?, name),
              phone_number = CASE WHEN ? THEN ? ELSE phone_number END,
              email = CASE WHEN ? THEN ? ELSE email END
            WHERE id = ? RETURNING ${employeeColumns}`,
          ).bind(
            value.name ?? null,
            value.phoneNumber === undefined ? 0 : 1,
            value.phoneNumber ?? null,
            value.email === undefined ? 0 : 1,
            value.email ?? null,
            key,
          ),
        ]);
        const row = updated.results[0];
        return row ? employee(row) : null;
      } catch (error) {
        throw emailConflict(error);
      }
    },

    async revokeWebSessions(employeeId) {
      const result = await db
        .prepare("DELETE FROM web_sessions WHERE employee_id = ?")
        .bind(id.parse(employeeId))
        .run();
      return result.meta.changes;
    },

    async listDevices(input = {}) {
      const value = directoryInput
        .extend({ employeeId: id.optional(), includeRevoked: z.boolean().default(false) })
        .parse(input);
      const conditions: string[] = value.includeRevoked ? [] : ["revoked_at IS NULL"];
      const bindings: (string | number)[] = [];
      if (value.employeeId) {
        conditions.push("employee_id = ?");
        bindings.push(value.employeeId);
      }
      if (value.cursor) {
        conditions.push("(created_at, id) < (?, ?)");
        bindings.push(value.cursor.sortAt, value.cursor.id);
      }
      const rows = await db
        .prepare(
          `SELECT ${managedDeviceColumns} FROM devices
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .bind(...bindings, value.limit + 1)
        .all<DeviceRow & { employee_name: string }>();
      return directoryPage(rows.results, value.limit, managedDevice);
    },

    async reassignDevice(deviceId, employeeId) {
      id.parse(deviceId);
      id.parse(employeeId);
      const now = timestamp(clock);
      // D1 serializes the batch; history and current assignment commit together.
      // A millisecond tie (or clock skew) cannot overwrite an earlier assignment.
      const [updated] = await db.batch<DeviceRow & { employee_name: string }>([
        db
          .prepare(
            `UPDATE devices SET
          assigned_at = CASE WHEN employee_id = ? THEN assigned_at
            WHEN assigned_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', assigned_at, '+0.001 seconds')
            ELSE ? END, employee_id = ?
          WHERE id = ? AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND active = 1)
          RETURNING ${managedDeviceColumns}`,
          )
          .bind(employeeId, now, now, employeeId, deviceId, employeeId),
        db
          .prepare(
            `INSERT INTO device_assignments (device_id, employee_id, assigned_at)
          SELECT id, employee_id, assigned_at FROM devices WHERE id = ? AND employee_id = ?
          AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM employees WHERE id = ? AND active = 1)
          ON CONFLICT(device_id, assigned_at) DO NOTHING`,
          )
          .bind(deviceId, employeeId, employeeId),
      ]);
      return updated.results[0] ? managedDevice(updated.results[0]) : null;
    },

    async listInvitations(employeeId, input = {}) {
      const value = directoryInput.extend({ includeRevoked: z.boolean().default(false) }).parse(input);
      const rows = await db
        .prepare(
          `SELECT ${invitationColumns} FROM invitations WHERE employee_id = ?
        ${value.includeRevoked ? "" : "AND revoked_at IS NULL"}
        ${value.cursor ? "AND (created_at, id) < (?, ?)" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .bind(
          id.parse(employeeId),
          ...(value.cursor ? [value.cursor.sortAt, value.cursor.id] : []),
          value.limit + 1,
        )
        .all<InvitationRow>();
      return directoryPage(rows.results, value.limit, invitationSummary);
    },

    async revokeInvitation(employeeId, invitationId) {
      const row = await db
        .prepare(
          `UPDATE invitations
        SET revoked_at = CASE WHEN redeemed_at IS NULL THEN COALESCE(revoked_at, ?) ELSE revoked_at END
        WHERE employee_id = ? AND id = ? RETURNING ${invitationColumns}`,
        )
        .bind(timestamp(clock), id.parse(employeeId), id.parse(invitationId))
        .first<InvitationRow>();
      return row ? invitationSummary(row) : null;
    },

    async createEmployee(
      input: z.input<typeof employeeInput>,
    ): Promise<Employee> {
      const value = employeeInput.parse(input);
      if (value.phoneNumber) await assertPhoneFree(db, value.phoneNumber, "");
      try {
        const row = await db
          .prepare(
            `INSERT INTO employees (id, name, phone_number, email, created_at)
          VALUES (?, ?, ?, ?, ?) RETURNING ${employeeColumns}`,
          )
          .bind(
            opaqueId("emp"),
            value.name,
            value.phoneNumber ?? null,
            value.email ?? null,
            timestamp(clock),
          )
          .first<EmployeeRow>();
        if (!row) throw new Error("Employee insert returned no record");
        return employee(row);
      } catch (error) {
        throw emailConflict(error);
      }
    },

    /** Deactivating also signs the employee out of every browser. */
    async setEmployeeActive(
      employeeId: string,
      active: boolean,
    ): Promise<Employee | null> {
      const enabled = z.boolean().parse(active);
      const key = id.parse(employeeId);
      const [, updated] = await db.batch<EmployeeRow>([
        db.prepare("DELETE FROM web_sessions WHERE employee_id = ? AND ? = 0").bind(key, enabled ? 1 : 0),
        db
          .prepare(`UPDATE employees SET active = ? WHERE id = ? RETURNING ${employeeColumns}`)
          .bind(enabled ? 1 : 0, key),
      ]);
      const row = updated.results[0];
      return row ? employee(row) : null;
    },

    async createInvitation(
      employeeId: string,
      expiresAt: string,
    ): Promise<(Invitation & { invitationCode: string }) | null> {
      id.parse(employeeId);
      const expiry = utcTimestamp.parse(expiresAt);
      const issued = await credentials.issueInvitationCode();
      const now = timestamp(clock);
      if (expiry <= now)
        throw new RangeError("Invitation expiry must be in the future");
      const row = await db
        .prepare(
          `INSERT INTO invitations (id, employee_id, code_hash, expires_at, created_at)
        SELECT ?, id, ?, ?, ? FROM employees WHERE id = ? AND active = 1 RETURNING ${invitationColumns}`,
        )
        .bind(opaqueId("inv"), issued.hash, expiry, now, employeeId)
        .first<InvitationRow>();
      return row ? { ...invitation(row), invitationCode: issued.code } : null;
    },

    async createRecoveryInvitation(deviceId, expiresAt) {
      id.parse(deviceId);
      const expiry = utcTimestamp.parse(expiresAt);
      const issued = await credentials.issueInvitationCode();
      const now = timestamp(clock);
      if (expiry <= now) throw new RangeError("Invitation expiry must be in the future");
      // Both statements share one serialized transaction. An invalid target cannot
      // revoke an outstanding code, and concurrent issuance leaves only the last live.
      const [, inserted] = await db.batch<InvitationRow>([
        db.prepare(`UPDATE invitations SET revoked_at = ?
          WHERE recovery_device_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM devices d JOIN employees e ON e.id = d.employee_id
            WHERE d.id = ? AND d.revoked_at IS NULL AND e.active = 1)`)
          .bind(now, deviceId, deviceId),
        db.prepare(`INSERT INTO invitations
          (id, employee_id, code_hash, expires_at, created_at, purpose, recovery_device_id, recovery_assigned_at)
          SELECT ?, d.employee_id, ?, ?, ?, 'recovery', d.id, d.assigned_at
          FROM devices d JOIN employees e ON e.id = d.employee_id
          WHERE d.id = ? AND d.revoked_at IS NULL AND e.active = 1
          RETURNING ${invitationColumns}`)
          .bind(opaqueId("inv"), issued.hash, expiry, now, deviceId),
      ]);
      const row = inserted.results[0];
      return row ? { ...invitation(row), invitationCode: issued.code } : null;
    },

    async getInvitation(invitationId: string): Promise<Invitation | null> {
      const row = await db
        .prepare(`SELECT ${invitationColumns} FROM invitations WHERE id = ?`)
        .bind(id.parse(invitationId))
        .first<InvitationRow>();
      return row ? invitation(row) : null;
    },

    async redeemInvitation(
      invitationCode: string,
      input: z.input<typeof deviceInput>,
    ) {
      const value = deviceInput.parse(input);
      const codeHash = await credentials.hashInvitationCode(
        z.string().min(1).parse(invitationCode),
      );
      const issued = await credentials.issueDeviceToken();
      const deviceId = opaqueId("dev");
      const now = timestamp(clock);
      // D1 serializes the complete transaction. The newly issued token hash is a
      // transaction-local witness: only a successful insert/rotation consumes a code.
      const [insert, recovery] = await db.batch<DeviceRow & { employee_name: string }>([
        db.prepare(`INSERT INTO devices
          (id, employee_id, token_hash, model, manufacturer, android_version, one_ui_version, app_version,
           created_at, assigned_at, phone_numbers, phone_numbers_reported_at, invitation_id, last_invitation_id)
          SELECT ?, i.employee_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, i.id, i.id FROM invitations i
          JOIN employees e ON e.id = i.employee_id
          WHERE i.code_hash = ? AND i.purpose = 'enrollment'
          AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND e.active = 1
          RETURNING ${managedDeviceColumns}`)
          .bind(deviceId, issued.hash, value.model ?? null, value.manufacturer ?? null,
            value.androidVersion ?? null, value.oneUiVersion ?? null, value.appVersion ?? null,
            now, now, JSON.stringify(value.phoneNumbers ?? []),
            value.phoneNumbers === undefined ? null : now, codeHash, now),
        db.prepare(`UPDATE devices SET token_hash = ?, model = ?, manufacturer = ?,
          android_version = ?, one_ui_version = ?, app_version = ?,
          phone_numbers = ?, phone_numbers_reported_at = ?, pending_uploads = NULL,
          last_seen_at = ?, last_invitation_id = (SELECT id FROM invitations WHERE code_hash = ?)
          WHERE revoked_at IS NULL AND EXISTS (
            SELECT 1 FROM invitations i JOIN employees e ON e.id = i.employee_id
            WHERE i.code_hash = ? AND i.purpose = 'recovery' AND i.recovery_device_id = devices.id
            AND i.employee_id = devices.employee_id AND i.recovery_assigned_at = devices.assigned_at
            AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? AND e.active = 1)
          RETURNING ${managedDeviceColumns}`)
          .bind(issued.hash, value.model ?? null, value.manufacturer ?? null,
            value.androidVersion ?? null, value.oneUiVersion ?? null, value.appVersion ?? null,
            JSON.stringify(value.phoneNumbers ?? []), value.phoneNumbers === undefined ? null : now,
            now, codeHash, codeHash, now),
        db.prepare(`UPDATE invitations SET redeemed_at = ?,
          device_id = (SELECT id FROM devices WHERE last_invitation_id = invitations.id AND token_hash = ? AND invitations.purpose = 'enrollment')
          WHERE code_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
          AND EXISTS (SELECT 1 FROM devices WHERE last_invitation_id = invitations.id AND token_hash = ?)`)
          .bind(now, issued.hash, codeHash, now, issued.hash),
      ]);
      const row = insert.results[0] ?? recovery.results[0];
      return row
        ? {
            device: device(row),
            employee: { id: row.employee_id, name: row.employee_name },
            deviceToken: issued.token,
          }
        : null;
    },

    async authenticateDevice(token: string): Promise<Device | null> {
      if (typeof token !== "string" || !/^ctd_[0-9a-f]{64}$/.test(token))
        return null;
      // Lookup uses a purpose-bound HMAC, never a plaintext/timing-sensitive token comparison.
      const tokenHash = await credentials.hashDeviceToken(token);
      const row = await db
        .prepare(
          `SELECT ${deviceColumns} FROM devices
        WHERE token_hash = ? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM employees WHERE id = devices.employee_id AND active = 1)`,
        )
        .bind(tokenHash)
        .first<DeviceRow>();
      return row ? device(row) : null;
    },

    async revokeDevice(deviceId: string): Promise<Device | null> {
      const row = await db
        .prepare(
          `UPDATE devices SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? RETURNING ${deviceColumns}`,
        )
        .bind(timestamp(clock), id.parse(deviceId))
        .first<DeviceRow>();
      return row ? device(row) : null;
    },

    async recordHeartbeat(
      deviceId: string,
      input: z.input<typeof heartbeatInput>,
    ): Promise<ManagedDevice | null> {
      const value = heartbeatInput.parse(input);
      if (value.deviceId !== undefined && value.deviceId !== deviceId)
        return null;
      const now = timestamp(clock);
      const row = await db
        .prepare(
          `UPDATE devices SET app_version = ?, pending_uploads = ?,
        last_successful_upload_at = COALESCE(?, last_successful_upload_at), last_seen_at = ?,
        phone_numbers = COALESCE(?, phone_numbers),
        phone_numbers_reported_at = CASE WHEN ? THEN ? ELSE phone_numbers_reported_at END
        WHERE id = ? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM employees WHERE id = devices.employee_id AND active = 1)
        RETURNING ${managedDeviceColumns}`,
        )
        .bind(
          value.appVersion,
          value.pendingUploads,
          value.lastSuccessfulUploadAt ?? null,
          now,
          value.phoneNumbers === undefined
            ? null
            : JSON.stringify(value.phoneNumbers),
          value.phoneNumbers === undefined ? 0 : 1,
          now,
          id.parse(deviceId),
        )
        .first<DeviceRow & { employee_name: string }>();
      return row ? managedDevice(row) : null;
    },
  };
}
