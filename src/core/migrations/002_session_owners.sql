-- Keep data ownership after the corresponding raw transcript has expired.
CREATE TABLE IF NOT EXISTS session_workspace_owners (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (session_id, workspace_id)
);

INSERT OR IGNORE INTO session_workspace_owners (session_id, workspace_id)
SELECT DISTINCT session_id, workspace_id FROM raw_events WHERE workspace_id != '';

CREATE TRIGGER IF NOT EXISTS raw_event_owner_insert
AFTER INSERT ON raw_events WHEN NEW.workspace_id != ''
BEGIN
  INSERT OR IGNORE INTO session_workspace_owners (session_id, workspace_id)
  VALUES (NEW.session_id, NEW.workspace_id);
END;

CREATE TRIGGER IF NOT EXISTS raw_event_owner_update
AFTER UPDATE OF workspace_id ON raw_events WHEN NEW.workspace_id != ''
BEGIN
  INSERT OR IGNORE INTO session_workspace_owners (session_id, workspace_id)
  VALUES (NEW.session_id, NEW.workspace_id);
END;
