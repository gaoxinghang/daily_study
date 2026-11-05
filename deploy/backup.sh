#!/bin/sh
set -eu
umask 077

backup_dir=/var/backups/daily-study-db
mkdir -p "$backup_dir"
backup_file="$backup_dir/daily_study-$(date +%Y%m%d-%H%M%S).dump"
trap 'rm -f "$backup_file.tmp"' EXIT

runuser -u postgres -- pg_dump -Fc daily_study > "$backup_file.tmp"
mv "$backup_file.tmp" "$backup_file"
find "$backup_dir" -type f -name 'daily_study-*.dump' -mtime +14 -delete
