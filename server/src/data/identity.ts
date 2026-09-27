import { z } from "zod";

import { createCredentials } from "../security/credentials";
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

const employeeInput = z.object({
  name: z.string().trim().min(1).max(200),
  phoneNumber: z.string().min(1).optional(),
});
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
    input: { name: string },
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

const employeeColumns = "id, name, phone_number, active, created_at";
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
    active: row.active === 1,
    createdAt: row.created_at,
  };
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

    async updateEmployee(employeeId, input) {
      const value = employeeInput.pick({ name: true }).parse(input);
      const row = await db
        .prepare(
          `UPDATE employees SET name = ? WHERE id = ? RETURNING ${employeeColumns}`,
        )
        .bind(value.name, id.parse(employeeId))
        .first<EmployeeRow>();
      return row ? employee(row) : null;
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
      const row = await db
        .prepare(
          `INSERT INTO employees (id, name, phone_number, created_at)
        VALUES (?, ?, ?, ?) RETURNING ${employeeColumns}`,
        )
        .bind(
          opaqueId("emp"),
          value.name,
          value.phoneNumber ?? null,
          timestamp(clock),
        )
        .first<EmployeeRow>();
      if (!row) throw new Error("Employee insert returned no record");
      return employee(row);
    },

    async setEmployeeActive(
      employeeId: string,
      active: boolean,
    ): Promise<Employee | null> {
      const row = await db
        .prepare(
          `UPDATE employees SET active = ? WHERE id = ? RETURNING ${employeeColumns}`,
        )
        .bind(z.boolean().parse(active) ? 1 : 0, id.parse(employeeId))
        .first<EmployeeRow>();
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
