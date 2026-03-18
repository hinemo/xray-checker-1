#!/bin/sh
set -eu

# Ensure writable volumes for SQLite and geo files when running with named volumes.
if [ "$(id -u)" = "0" ]; then
  chown -R appuser:appuser /app/data /app/geo 2>/dev/null || true
  exec su-exec appuser /usr/bin/xray-checker
fi

exec /usr/bin/xray-checker
