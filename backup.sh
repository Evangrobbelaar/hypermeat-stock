#!/usr/bin/env bash
set -euo pipefail
docker exec hypermeat-stock sh -c 'sqlite3 /data/stock.db ".backup /data/backup-$(date +%F).db"'
docker exec hypermeat-stock sh -c "find /data -name 'backup-*.db' -mtime +14 -delete"
docker exec hypermeat-stock sh -c '[ -d /data/photos ] && tar -czf "/data/photos-backup-$(date +%F).tar.gz" -C /data photos || true'
docker exec hypermeat-stock sh -c "find /data -name 'photos-backup-*.tar.gz' -mtime +14 -delete"
echo "[$(date -Iseconds)] backup ok: $(docker exec hypermeat-stock sh -c 'ls -1 /data/backup-*.db 2>/dev/null | tail -1') $(docker exec hypermeat-stock sh -c 'ls -1 /data/photos-backup-*.tar.gz 2>/dev/null | tail -1')"
