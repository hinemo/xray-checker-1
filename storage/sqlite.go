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
`

	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("failed to initialize sqlite schema: %w", err)
	}

	return nil
}

func (s *SQLiteStore) SyncSubscriptions(urls []string, proxies []*models.ProxyConfig) error {
	if s == nil || s.db == nil {
		return nil
	}

	names := make(map[string]struct{})
	for _, p := range proxies {
		if p.SubName != "" {
			names[p.SubName] = struct{}{}
		}
	}

	name := ""
	for subName := range names {
		name = subName
		break
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
