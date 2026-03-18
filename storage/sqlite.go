package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"
	"xray-checker/models"

	_ "modernc.org/sqlite"
)

type NodeCheckResult struct {
	StableID  string
	Online    bool
	LatencyMs int64
}

type ScheduleSettings struct {
	AutoFetchEnabled bool
	AutoFetchMinutes int
	AutoCheckEnabled bool
	AutoCheckMinutes int
	UpdatedAt        time.Time
}

type ActionLog struct {
	ID        int
	Action    string
	Status    string
	Message   string
	CreatedAt time.Time
}

type SubscriptionGroup struct {
	Name          string
	NodeCount     int
	LastUpdatedAt *time.Time
	LastCheckedAt *time.Time
}

type SQLiteStore struct {
	db *sql.DB
}

func NewSQLiteStore(dbPath string) (*SQLiteStore, error) {
	if dbPath == "" {
		return nil, fmt.Errorf("database path is empty")
	}

	dir := filepath.Dir(dbPath)
	if dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create database directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database: %w", err)
	}

	store := &SQLiteStore{db: db}
	if err := store.initSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}

	return store, nil
}

func (s *SQLiteStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SQLiteStore) initSchema() error {
	schema := `
CREATE TABLE IF NOT EXISTS subscriptions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	source_url TEXT NOT NULL UNIQUE,
	name TEXT,
	updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	auto_fetch_enabled INTEGER NOT NULL,
	auto_fetch_minutes INTEGER NOT NULL,
	auto_check_enabled INTEGER NOT NULL,
	auto_check_minutes INTEGER NOT NULL,
	updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS action_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	action TEXT NOT NULL,
	status TEXT NOT NULL,
	message TEXT,
	created_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
	stable_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	sub_name TEXT,
	protocol TEXT NOT NULL,
	server TEXT NOT NULL,
	port INTEGER NOT NULL,
	proxy_index INTEGER NOT NULL,
	updated_at DATETIME NOT NULL,
	last_online INTEGER DEFAULT 0,
	last_latency_ms INTEGER DEFAULT 0,
	last_checked_at DATETIME
);

CREATE TABLE IF NOT EXISTS node_checks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	stable_id TEXT NOT NULL,
	online INTEGER NOT NULL,
	latency_ms INTEGER NOT NULL,
	checked_at DATETIME NOT NULL,
	FOREIGN KEY(stable_id) REFERENCES nodes(stable_id)
);

CREATE INDEX IF NOT EXISTS idx_node_checks_stable_id_checked_at
	ON node_checks(stable_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_action_logs_created_at
	ON action_logs(created_at DESC);
`

	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("failed to initialize sqlite schema: %w", err)
	}

	return nil
}

func (s *SQLiteStore) GetScheduleSettings() (*ScheduleSettings, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}

	row := s.db.QueryRow(`
SELECT auto_fetch_enabled, auto_fetch_minutes, auto_check_enabled, auto_check_minutes, updated_at
FROM schedule_settings
WHERE id = 1
`)

	var autoFetchEnabled int
	var autoFetchMinutes int
	var autoCheckEnabled int
	var autoCheckMinutes int
	var updatedAt time.Time
	if err := row.Scan(&autoFetchEnabled, &autoFetchMinutes, &autoCheckEnabled, &autoCheckMinutes, &updatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to query schedule settings: %w", err)
	}

	return &ScheduleSettings{
		AutoFetchEnabled: autoFetchEnabled == 1,
		AutoFetchMinutes: autoFetchMinutes,
		AutoCheckEnabled: autoCheckEnabled == 1,
		AutoCheckMinutes: autoCheckMinutes,
		UpdatedAt:        updatedAt,
	}, nil
}

func (s *SQLiteStore) UpsertScheduleSettings(settings ScheduleSettings) error {
	if s == nil || s.db == nil {
		return nil
	}

	autoFetchEnabled := 0
	if settings.AutoFetchEnabled {
		autoFetchEnabled = 1
	}
	autoCheckEnabled := 0
	if settings.AutoCheckEnabled {
		autoCheckEnabled = 1
	}

	now := time.Now().UTC()
	_, err := s.db.Exec(`
INSERT INTO schedule_settings(id, auto_fetch_enabled, auto_fetch_minutes, auto_check_enabled, auto_check_minutes, updated_at)
VALUES(1, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	auto_fetch_enabled=excluded.auto_fetch_enabled,
	auto_fetch_minutes=excluded.auto_fetch_minutes,
	auto_check_enabled=excluded.auto_check_enabled,
	auto_check_minutes=excluded.auto_check_minutes,
	updated_at=excluded.updated_at;
`, autoFetchEnabled, settings.AutoFetchMinutes, autoCheckEnabled, settings.AutoCheckMinutes, now)

	if err != nil {
		return fmt.Errorf("failed to upsert schedule settings: %w", err)
	}

	return nil
}

func (s *SQLiteStore) AddActionLog(action, status, message string) error {
	if s == nil || s.db == nil {
		return nil
	}

	now := time.Now().UTC()
	_, err := s.db.Exec(`
INSERT INTO action_logs(action, status, message, created_at)
VALUES(?, ?, ?, ?);
`, action, status, message, now)

	if err != nil {
		return fmt.Errorf("failed to insert action log: %w", err)
	}

	return nil
}

func (s *SQLiteStore) ListActionLogsFiltered(action, status, query string, limit int) ([]ActionLog, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}

	if limit <= 0 {
		limit = 50
	}

	where := ""
	args := make([]any, 0)
	if action != "" {
		where = appendWhere(where, "action = ?")
		args = append(args, action)
	}
	if status != "" {
		where = appendWhere(where, "status = ?")
		args = append(args, status)
	}
	if query != "" {
		like := "%" + query + "%"
		where = appendWhere(where, "(action LIKE ? OR status LIKE ? OR message LIKE ?)")
		args = append(args, like, like, like)
	}

	stmt := "SELECT id, action, status, message, created_at FROM action_logs " + where + " ORDER BY created_at DESC LIMIT ?"
	args = append(args, limit)

	rows, err := s.db.Query(stmt, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query action logs: %w", err)
	}
	defer rows.Close()

	logs := make([]ActionLog, 0)
	for rows.Next() {
		var log ActionLog
		if err := rows.Scan(&log.ID, &log.Action, &log.Status, &log.Message, &log.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan action log: %w", err)
		}
		logs = append(logs, log)
	}

	return logs, nil
}

func appendWhere(existing, clause string) string {
	if existing == "" {
		return "WHERE " + clause
	}
	return existing + " AND " + clause
}

func (s *SQLiteStore) ListSubscriptionGroups() ([]SubscriptionGroup, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}

	rows, err := s.db.Query(`
SELECT sub_name, COUNT(*), MAX(updated_at), MAX(last_checked_at)
FROM nodes
WHERE sub_name IS NOT NULL AND sub_name != ''
GROUP BY sub_name
ORDER BY sub_name ASC
`)
	if err != nil {
		return nil, fmt.Errorf("failed to query subscription groups: %w", err)
	}
	defer rows.Close()

	groups := make([]SubscriptionGroup, 0)
	for rows.Next() {
		var name string
		var count int
		var updatedAt sql.NullTime
		var checkedAt sql.NullTime
		if err := rows.Scan(&name, &count, &updatedAt, &checkedAt); err != nil {
			return nil, fmt.Errorf("failed to scan subscription group: %w", err)
		}

		group := SubscriptionGroup{
			Name:      name,
			NodeCount: count,
		}
		if updatedAt.Valid {
			group.LastUpdatedAt = &updatedAt.Time
		}
		if checkedAt.Valid {
			group.LastCheckedAt = &checkedAt.Time
		}
		groups = append(groups, group)
	}

	return groups, nil
}

func (s *SQLiteStore) GetSubscriptions() ([]string, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}

	rows, err := s.db.Query("SELECT source_url FROM subscriptions")
	if err != nil {
		return nil, fmt.Errorf("failed to query subscriptions: %w", err)
	}
	defer rows.Close()

	var urls []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, fmt.Errorf("failed to scan subscription url: %w", err)
		}
		urls = append(urls, u)
	}

	return urls, nil
}

func (s *SQLiteStore) AddSubscription(url string) error {
	if s == nil || s.db == nil {
		return nil
	}

	now := time.Now().UTC()
	_, err := s.db.Exec(`
INSERT INTO subscriptions(source_url, name, updated_at)
VALUES(?, ?, ?)
ON CONFLICT(source_url) DO UPDATE SET
	updated_at=excluded.updated_at;
`, url, "", now)

	if err != nil {
		return fmt.Errorf("failed to add subscription %s: %w", url, err)
	}

	return nil
}

func (s *SQLiteStore) DeleteSubscription(url string) error {
	if s == nil || s.db == nil {
		return nil
	}

	_, err := s.db.Exec("DELETE FROM subscriptions WHERE source_url = ?", url)
	if err != nil {
		return fmt.Errorf("failed to delete subscription %s: %w", url, err)
	}

	return nil
}

func (s *SQLiteStore) SyncSubscriptions(urls []string, names map[string]string) error {
	if s == nil || s.db == nil {
		return nil
	}

	now := time.Now().UTC()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to start subscription transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	stmt, err := tx.Prepare(`
INSERT INTO subscriptions(source_url, name, updated_at)
VALUES(?, ?, ?)
ON CONFLICT(source_url) DO UPDATE SET
	name=excluded.name,
	updated_at=excluded.updated_at;
`)
	if err != nil {
		return fmt.Errorf("failed to prepare subscription upsert statement: %w", err)
	}
	defer stmt.Close()

	for _, u := range urls {
		name := ""
		if names != nil {
			name = names[u]
		}
		if _, err = stmt.Exec(u, name, now); err != nil {
			return fmt.Errorf("failed to upsert subscription %s: %w", u, err)
		}
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit subscription transaction: %w", err)
	}

	return nil
}

func (s *SQLiteStore) ReplaceNodes(proxies []*models.ProxyConfig) error {
	if s == nil || s.db == nil {
		return nil
	}

	now := time.Now().UTC()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to start node transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.Exec("DELETE FROM nodes"); err != nil {
		return fmt.Errorf("failed to clear nodes table: %w", err)
	}

	insertStmt, err := tx.Prepare(`
INSERT INTO nodes(stable_id, name, sub_name, protocol, server, port, proxy_index, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?);
`)
	if err != nil {
		return fmt.Errorf("failed to prepare node insert statement: %w", err)
	}
	defer insertStmt.Close()

	for _, p := range proxies {
		if p.StableID == "" {
			p.StableID = p.GenerateStableID()
		}

		if _, err = insertStmt.Exec(
			p.StableID,
			p.Name,
			p.SubName,
			p.Protocol,
			p.Server,
			p.Port,
			p.Index,
			now,
		); err != nil {
			return fmt.Errorf("failed to insert node %s: %w", p.Name, err)
		}
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit node transaction: %w", err)
	}

	return nil
}

func (s *SQLiteStore) SaveNodeChecks(results []NodeCheckResult) error {
	if s == nil || s.db == nil || len(results) == 0 {
		return nil
	}

	now := time.Now().UTC()
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to start check transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	checkStmt, err := tx.Prepare(`
INSERT INTO node_checks(stable_id, online, latency_ms, checked_at)
VALUES(?, ?, ?, ?);
`)
	if err != nil {
		return fmt.Errorf("failed to prepare check insert statement: %w", err)
	}
	defer checkStmt.Close()

	updateStmt, err := tx.Prepare(`
UPDATE nodes
SET last_online = ?,
	last_latency_ms = ?,
	last_checked_at = ?,
	updated_at = ?
WHERE stable_id = ?;
`)
	if err != nil {
		return fmt.Errorf("failed to prepare node update statement: %w", err)
	}
	defer updateStmt.Close()

	for _, result := range results {
		online := 0
		if result.Online {
			online = 1
		}

		if _, err = checkStmt.Exec(result.StableID, online, result.LatencyMs, now); err != nil {
			return fmt.Errorf("failed to insert check for node %s: %w", result.StableID, err)
		}

		if _, err = updateStmt.Exec(online, result.LatencyMs, now, now, result.StableID); err != nil {
			return fmt.Errorf("failed to update node %s: %w", result.StableID, err)
		}
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit check transaction: %w", err)
	}

	return nil
}
