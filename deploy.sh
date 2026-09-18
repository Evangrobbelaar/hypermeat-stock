#!/usr/bin/env bash
# Deploy the Hyper Meat stock portal on the ClockPay VPS.
# Run on the VPS as root or a docker-capable user:
#   bash deploy.sh
set -euo pipefail

REPO="https://github.com/Evangrobbelaar/hypermeat-stock.git"
DIR="${STOCK_DIR:-/opt/hypermeat-stock}"
PORT=8100

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mFailed: %s\033[0m\n' "$1" >&2; exit 1; }

command -v docker >/dev/null || die "Docker is not installed on this host."
docker compose version >/dev/null 2>&1 || die "The docker compose plugin is missing."

say "Checking port $PORT is free"
if ss -lntp 2>/dev/null | grep -q ":$PORT "; then
  ss -lntp | grep ":$PORT " || true
  docker ps --format '{{.Names}}' | grep -qx hypermeat-stock \
    || die "Port $PORT is already in use by something else. Set a different port in docker-compose.yml."
  echo "Port held by the existing hypermeat-stock container. Continuing with a redeploy."
fi

say "Fetching source into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin main
  git -C "$DIR" reset --quiet --hard origin/main
else
  git clone --quiet "$REPO" "$DIR"
fi
cd "$DIR"

say "Building and starting the container"
docker compose up -d --build

say "Waiting for the service to answer"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    OK=1; break
  fi
  sleep 2
done
[ "${OK:-0}" = "1" ] || { docker compose logs --tail 40 stock; die "Service did not come up. Logs above."; }

say "Smoke test"
curl -fsS "http://127.0.0.1:$PORT/healthz"; echo
LOCS=$(curl -fsS "http://127.0.0.1:$PORT/api/locations")
echo "Seeded locations: $LOCS"

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<EOF

Running on port $PORT.
  On the VPS      http://127.0.0.1:$PORT
  From a tablet   http://${IP:-<vps-ip>}:$PORT

Next:
  1. Open the firewall if the tablets are off-host:  ufw allow $PORT/tcp
  2. Change the seeded PINs (1111 / 9999) before staff use it.
  3. Put HTTPS in front of it before it goes over the 4G link.

Logs:     docker compose -f $DIR/docker-compose.yml logs -f stock
Restart:  docker compose -f $DIR/docker-compose.yml restart stock
Backup:   docker exec hypermeat-stock sh -c 'sqlite3 /data/stock.db ".backup /data/backup.db"'
EOF
