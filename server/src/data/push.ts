import { type Clock, timestamp } from "./values";

export function createPushRepository(db: D1Database, clock: Clock = () => new Date()) {
  return {
    async setToken(deviceId: string, token: string): Promise<void> {
      await db.prepare(
        `INSERT INTO device_push_tokens (device_id, token, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at`,
      ).bind(deviceId, token, timestamp(clock)).run();
      // A token belongs to one phone: a reinstalled or reassigned phone's old row must not receive a second copy.
      await db.prepare("DELETE FROM device_push_tokens WHERE token = ? AND device_id <> ?").bind(token, deviceId).run();
    },
    async clearToken(deviceId: string): Promise<void> {
      await db.prepare("DELETE FROM device_push_tokens WHERE device_id = ?").bind(deviceId).run();
    },
    async deleteToken(token: string): Promise<void> {
      await db.prepare("DELETE FROM device_push_tokens WHERE token = ?").bind(token).run();
    },
    /** Tokens of the active, non-revoked phones of these employees. */
    async tokensFor(employeeIds: string[]): Promise<string[]> {
      const ids = [...new Set(employeeIds)].slice(0, 50);
      if (ids.length === 0) return [];
      const rows = await db.prepare(
        `SELECT DISTINCT t.token FROM device_push_tokens t
        JOIN devices d ON d.id = t.device_id AND d.revoked_at IS NULL
        JOIN employees e ON e.id = d.employee_id AND e.active = 1
        WHERE d.employee_id IN (${ids.map(() => "?").join(",")})`,
      ).bind(...ids).all<{ token: string }>();
      return rows.results.map((row) => row.token);
    },
  };
}
