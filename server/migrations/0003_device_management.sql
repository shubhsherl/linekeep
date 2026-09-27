ALTER TABLE invitations ADD COLUMN revoked_at TEXT;
ALTER TABLE devices ADD COLUMN phone_numbers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE devices ADD COLUMN phone_numbers_reported_at TEXT;
ALTER TABLE devices ADD COLUMN assigned_at TEXT;

UPDATE devices SET assigned_at = created_at;

CREATE TABLE device_assignments (
  device_id TEXT NOT NULL REFERENCES devices(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  assigned_at TEXT NOT NULL,
  is_initial INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0, 1)),
  PRIMARY KEY (device_id, assigned_at)
);
CREATE UNIQUE INDEX device_assignments_initial_idx ON device_assignments(device_id) WHERE is_initial = 1;
INSERT INTO device_assignments (device_id, employee_id, assigned_at, is_initial)
SELECT id, employee_id, created_at, 1 FROM devices;

-- The previous Worker may still register devices between migration and deployment.
-- Keep initial history atomic for both versions and for controlled SQL seeding.
CREATE TRIGGER devices_initial_assignment AFTER INSERT ON devices
BEGIN
  UPDATE devices SET assigned_at = COALESCE(NEW.assigned_at, NEW.created_at) WHERE id = NEW.id;
  INSERT INTO device_assignments (device_id, employee_id, assigned_at, is_initial)
  VALUES (NEW.id, NEW.employee_id, COALESCE(NEW.assigned_at, NEW.created_at), 1);
END;

CREATE INDEX employees_directory_idx ON employees(created_at DESC, id DESC);
CREATE INDEX devices_directory_idx ON devices(created_at DESC, id DESC);
CREATE INDEX devices_employee_directory_idx ON devices(employee_id, created_at DESC, id DESC);
CREATE INDEX invitations_directory_idx ON invitations(employee_id, created_at DESC, id DESC);
