#!/usr/bin/env bash
# Keeps Bingo running on a Linux/macOS host: restarts it 2 s after any exit.
# Run it from the frozen tournament copy: ./scripts/live.sh
cd "$(dirname "$0")/.." || exit 1
while true; do
  echo "[live] starting bot at $(date +%H:%M:%S)"
  node --import tsx src/bot/index.ts < /dev/null
  echo "[live] bot exited with code $? at $(date +%H:%M:%S); restarting in 2 s"
  sleep 2
done
