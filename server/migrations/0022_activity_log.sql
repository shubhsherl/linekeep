-- Activity log: an append-only record of who did what (sign-ins, devices, customers, WhatsApp, calls, admin changes).
-- Additive only. Rows hold ids, names as they were at the time, and small facts (counts, field NAMES, message type,
-- template name). Never message text, notes, phone numbers, one-time codes or file contents. The IP address and the
-- browser are kept for sign-in (security) rows only. Rows older than the retention setting (default 90 days) are
-- deleted by the daily job.

CREATE TABLE activity_log (
  id TEXT PRIMARY KEY CHECK (id GLOB 'act_*'),
  -- UTC RFC 3339 with milliseconds, like every other timestamp; sorts lexicographically.
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('employee', 'admin', 'system', 'customer')),
  -- Employee id, administrator e-mail (as verified by Cloudflare Access; "local" in development), or customer id.
  actor_id TEXT,
  -- The actor's name at the time of the event (a snapshot: renaming or deleting the employee later does not rewrite history).
  actor_name TEXT,
  category TEXT NOT NULL CHECK (category IN ('signin', 'device', 'customer', 'whatsapp', 'call', 'admin')),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 60),
  -- What the event is about: customer, employee, device, call or template; the label is a snapshot too.
  target_type TEXT CHECK (target_type IS NULL OR target_type IN ('customer', 'employee', 'device', 'call', 'template')),
  target_id TEXT,
  target_label TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('app', 'web', 'admin', 'system')),
  -- A small flat JSON object; its keys are allow-listed per action in server/src/activity/catalog.ts.
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details) AND json_type(details) = 'object'),
  -- Security rows (category 'signin') only.
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX activity_log_time_idx ON activity_log(occurred_at DESC, id DESC);
CREATE INDEX activity_log_actor_idx ON activity_log(actor_id, occurred_at DESC);
CREATE INDEX activity_log_category_idx ON activity_log(category, occurred_at DESC);
CREATE INDEX activity_log_target_idx ON activity_log(target_id, occurred_at DESC);

-- When each employee last did anything through the app or the web app; written at most once every five minutes.
CREATE TABLE employee_activity_summary (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  last_active_at TEXT NOT NULL,
  last_channel TEXT NOT NULL CHECK (last_channel IN ('app', 'web'))
);

-- Backfill from what the earlier tables recorded, bounded to the last 90 days. Row ids are derived from the source
-- row ("act_bf_..."), so running these statements again changes nothing. Every such row says details.backfilled.
-- A customer name that is only a phone number (WhatsApp creates customers that way) is stored masked, as the
-- server does for new rows.

-- Messages employees sent (administrator and automatic sends carry no employee and are not reconstructable).
INSERT OR IGNORE INTO activity_log (id, occurred_at, actor_type, actor_id, actor_name, category, action,
    target_type, target_id, target_label, channel, details)
SELECT 'act_bf_wam_' || m.id, m.sent_at, 'employee', m.sent_by_employee_id, e.name, 'whatsapp',
  CASE WHEN m.status = 'failed' THEN 'message_failed' ELSE 'message_sent' END,
  'customer', m.customer_id,
  CASE WHEN c.name NOT GLOB '*[A-Za-z]*' AND c.name GLOB '*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*'
    THEN '••••' || substr(c.name, -4) ELSE c.name END,
  'app',
  json_object('backfilled', json('true'),
    'type', CASE m.message_type WHEN 'text' THEN 'text' WHEN 'template' THEN 'template' ELSE 'media' END)
FROM whatsapp_messages m
JOIN employees e ON e.id = m.sent_by_employee_id
JOIN customers c ON c.id = m.customer_id
WHERE m.direction = 'out' AND m.sent_by_employee_id IS NOT NULL
  AND m.sent_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days');

-- Customers an employee added from the app.
INSERT OR IGNORE INTO activity_log (id, occurred_at, actor_type, actor_id, actor_name, category, action,
    target_type, target_id, target_label, channel, details)
SELECT 'act_bf_cus_' || c.id, c.created_at, 'employee', c.created_by_employee_id, e.name, 'customer', 'created',
  'customer', c.id,
  CASE WHEN c.name NOT GLOB '*[A-Za-z]*' AND c.name GLOB '*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*[0-9]*'
    THEN '••••' || substr(c.name, -4) ELSE c.name END,
  'app',
  json_object('backfilled', json('true'), 'source', 'employee_app')
FROM customers c
JOIN employees e ON e.id = c.created_by_employee_id
WHERE c.created_by_employee_id IS NOT NULL
  AND c.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days');

-- Web sign-ins (one row per session; sessions end and are cleaned up, so older ones may be gone).
INSERT OR IGNORE INTO activity_log (id, occurred_at, actor_type, actor_id, actor_name, category, action,
    target_type, target_id, target_label, channel, details)
SELECT 'act_bf_wss_' || s.id, s.created_at, 'employee', s.employee_id, e.name, 'signin', 'signed_in',
  NULL, NULL, NULL, 'web', json_object('backfilled', json('true'))
FROM web_sessions s
JOIN employees e ON e.id = s.employee_id
WHERE s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days');

-- Phones enrolled (to the employee the phone was first given to) and phones revoked.
INSERT OR IGNORE INTO activity_log (id, occurred_at, actor_type, actor_id, actor_name, category, action,
    target_type, target_id, target_label, channel, details)
SELECT 'act_bf_dev_' || d.id, d.created_at, 'employee', x.employee_id, e.name, 'device', 'enrolled',
  'device', d.id, d.model, 'app',
  json_object('backfilled', json('true'))
FROM devices d
JOIN (SELECT d2.id AS device_id,
        COALESCE((SELECT a.employee_id FROM device_assignments a WHERE a.device_id = d2.id AND a.is_initial = 1), d2.employee_id) AS employee_id
      FROM devices d2) x ON x.device_id = d.id
JOIN employees e ON e.id = x.employee_id
WHERE d.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days');

INSERT OR IGNORE INTO activity_log (id, occurred_at, actor_type, actor_id, actor_name, category, action,
    target_type, target_id, target_label, channel, details)
SELECT 'act_bf_rev_' || d.id, d.revoked_at, 'admin', NULL, 'Administrator', 'device', 'revoked',
  'device', d.id, d.model, 'admin',
  json_object('backfilled', json('true'))
FROM devices d
WHERE d.revoked_at IS NOT NULL
  AND d.revoked_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days');

-- Last active: the most recent phone check-in or web session use. With a single max(), SQLite takes the
-- bare column (channel) from the row that holds the maximum.
INSERT OR IGNORE INTO employee_activity_summary (employee_id, last_active_at, last_channel)
SELECT employee_id, max(at), channel FROM (
  SELECT employee_id, last_seen_at AS at, 'app' AS channel FROM devices WHERE last_seen_at IS NOT NULL
  UNION ALL
  SELECT employee_id, last_seen_at AS at, 'web' AS channel FROM web_sessions
) GROUP BY employee_id;
