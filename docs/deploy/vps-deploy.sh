#!/usr/bin/env bash
# Lives on the VPS at /docker/deploy.sh. The GitHub deploy key is locked to this script
# (authorized_keys: restrict,command="/docker/deploy.sh"), so the project name arrives in
# $SSH_ORIGINAL_COMMAND and nothing else can be run with that key.
set -euo pipefail

project="${SSH_ORIGINAL_COMMAND:-${1:-}}"
case "$project" in
  retail | menu) ;;
  *) echo "unknown project: $project" >&2; exit 2 ;;
esac

exec 9>"/var/lock/deploy-$project.lock"
flock -n 9 || { echo "a deploy of $project is already running" >&2; exit 3; }

cd "/docker/$project"

# Keep the running image as :before so a bad deploy can be rolled back by hand.
for img in $(docker compose config --images); do
  name="${img%%:*}"
  docker tag "$name:latest" "$name:before" 2>/dev/null || true
done

docker compose build
docker compose up -d
docker image prune -f > /dev/null
echo "deployed $project"
