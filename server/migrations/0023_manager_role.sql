-- Manager level: an administrator can make an employee a manager and assign employees to report to them.
-- Additive only. A manager sees (and can do everything an employee can do for) themselves and their team.
-- Single level: a manager has no manager; an employee reports only to an active manager.

ALTER TABLE employees ADD COLUMN role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager'));
ALTER TABLE employees ADD COLUMN manager_id TEXT REFERENCES employees(id);
-- A manager may be told (push) about new customer messages of their reports' customers. Off by default.
ALTER TABLE employees ADD COLUMN notify_team_messages INTEGER NOT NULL DEFAULT 0 CHECK (notify_team_messages IN (0, 1));

CREATE INDEX employees_manager_idx ON employees(manager_id) WHERE manager_id IS NOT NULL;

-- The rules are enforced by the API; these guards make them hold for concurrent writers too.
CREATE TRIGGER employees_manager_insert_guard BEFORE INSERT ON employees
WHEN NEW.manager_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid_manager') WHERE NEW.role <> 'employee' OR NOT EXISTS (
    SELECT 1 FROM employees m WHERE m.id = NEW.manager_id AND m.role = 'manager' AND m.active = 1
  );
END;

CREATE TRIGGER employees_manager_update_guard BEFORE UPDATE OF manager_id, role ON employees
WHEN NEW.manager_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid_manager') WHERE NEW.role <> 'employee' OR NEW.manager_id = NEW.id OR NOT EXISTS (
    SELECT 1 FROM employees m WHERE m.id = NEW.manager_id AND m.role = 'manager' AND m.active = 1
  );
END;

CREATE TRIGGER employees_demote_guard BEFORE UPDATE OF role ON employees
WHEN OLD.role = 'manager' AND NEW.role <> 'manager'
BEGIN
  SELECT RAISE(ABORT, 'manager_has_team') WHERE EXISTS (SELECT 1 FROM employees r WHERE r.manager_id = OLD.id);
END;
