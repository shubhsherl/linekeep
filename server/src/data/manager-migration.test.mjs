import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { unstable_splitSqlQuery } from "wrangler";

import { createDatabase } from "./test-support.mjs";

const migration = new URL("../../migrations/0023_manager_role.sql", import.meta.url);

async function applyManagerMigration(DB) {
  const statements = unstable_splitSqlQuery(await readFile(migration, "utf8"));
  await DB.batch(statements.map((statement) => DB.prepare(statement)));
}

test("migration 0023 upgrades an existing database: everyone stays an employee with no manager", async (t) => {
  const DB = await createDatabase(t, "0022_activity_log.sql");
  await DB.batch([
    ["emp_old_1", "Old One"], ["emp_old_2", "Old Two"], ["emp_old_3", "Old Three"],
  ].map(([id, name]) => DB.prepare("INSERT INTO employees (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')").bind(id, name)));
  await DB.prepare("UPDATE employees SET active = 0 WHERE id = 'emp_old_3'").run();
  await DB.prepare(
    `INSERT INTO customers (id, name, phone, phone_key, country, created_at, updated_at)
     VALUES ('cus_old', 'Old Customer', '+919800000100', '9800000100', 'India', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  await DB.prepare("INSERT INTO customer_employees (customer_id, employee_id, assigned_at) VALUES ('cus_old', 'emp_old_1', '2026-01-01T00:00:00.000Z')").run();

  await applyManagerMigration(DB);

  const rows = (await DB.prepare("SELECT id, name, active, role, manager_id, notify_team_messages FROM employees ORDER BY id").all()).results;
  assert.deepEqual(rows.map((row) => [row.id, row.role, row.manager_id, row.notify_team_messages]), [
    ["emp_old_1", "employee", null, 0], ["emp_old_2", "employee", null, 0], ["emp_old_3", "employee", null, 0],
  ]);
  assert.equal(rows[2].active, 0);
  // Existing data is untouched.
  assert.equal((await DB.prepare("SELECT count(*) AS n FROM customer_employees WHERE customer_id = 'cus_old'").first()).n, 1);

  // The new columns work and the rules are enforced by the database.
  await DB.prepare("UPDATE employees SET role = 'manager' WHERE id = 'emp_old_1'").run();
  await DB.prepare("UPDATE employees SET manager_id = 'emp_old_1' WHERE id = 'emp_old_2'").run();
  await assert.rejects(DB.prepare("UPDATE employees SET manager_id = 'emp_old_3' WHERE id = 'emp_old_2'").run(), /invalid_manager/);
  await assert.rejects(DB.prepare("UPDATE employees SET role = 'employee' WHERE id = 'emp_old_1'").run(), /manager_has_team/);
  await assert.rejects(DB.prepare("UPDATE employees SET role = 'boss' WHERE id = 'emp_old_3'").run());
  await DB.prepare("UPDATE employees SET manager_id = NULL WHERE id = 'emp_old_2'").run();
  await DB.prepare("UPDATE employees SET role = 'employee' WHERE id = 'emp_old_1'").run();
});

test("a fresh database through every migration has the manager columns and defaults", async (t) => {
  const DB = await createDatabase(t);
  await DB.prepare("INSERT INTO employees (id, name, created_at) VALUES ('emp_new', 'New', '2026-01-01T00:00:00.000Z')").run();
  const row = await DB.prepare("SELECT role, manager_id, notify_team_messages FROM employees WHERE id = 'emp_new'").first();
  assert.deepEqual([row.role, row.manager_id, row.notify_team_messages], ["employee", null, 0]);
});
