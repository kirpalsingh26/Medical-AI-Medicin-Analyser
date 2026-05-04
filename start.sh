#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start.sh  –  Start all MedVision services
#
# Usage:
#   ./start.sh            # start everything (recommended)
#   ./start.sh --no-ocr   # skip Python OCR service (Tesseract-only mode)
#   ./start.sh --no-ui    # skip frontend
#   ./start.sh --prod     # production mode (no Vite dev server)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
OCR_DIR="$BACKEND_DIR/ocr_service"

NO_OCR=false
NO_UI=false
PROD=false

for arg in "$@"; do
  case $arg in
    --no-ocr) NO_OCR=true ;;
    --no-ui)  NO_UI=true  ;;
    --prod)   PROD=true   ;;
  esac
done

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[MedVision]${RESET} $*"; }
ok()   { echo -e "${GREEN}[  OK  ]${RESET} $*"; }
warn() { echo -e "${YELLOW}[ WARN ]${RESET} $*"; }
err()  { echo -e "${RED}[ ERR  ]${RESET} $*"; }

# ── PID tracking (for clean shutdown) ────────────────────────────────────────
PIDS=()

cleanup() {
  echo ""
  log "Shutting down all services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null && echo "  killed PID $pid"
  done
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── check prerequisites ───────────────────────────────────────────────────────
log "Checking prerequisites..."

command -v node  >/dev/null 2>&1 || { err "node not found. Install Node.js >= 18"; exit 1; }
command -v npm   >/dev/null 2>&1 || { err "npm not found."; exit 1; }

if $NO_OCR; then
  warn "Skipping Python OCR service (--no-ocr flag set)"
else
  command -v python3 >/dev/null 2>&1 || { warn "python3 not found – running in Tesseract-only mode"; NO_OCR=true; }
fi

# ── install Node deps if needed ───────────────────────────────────────────────
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  log "Installing backend Node.js dependencies..."
  (cd "$BACKEND_DIR" && npm install --silent)
fi

if [ ! -d "$FRONTEND_DIR/node_modules" ] && ! $NO_UI; then
  log "Installing frontend Node.js dependencies..."
  (cd "$FRONTEND_DIR" && npm install --silent)
fi

# ── install Python deps if needed ────────────────────────────────────────────
if ! $NO_OCR; then
  if ! python3 -c "import fastapi" 2>/dev/null; then
    log "Installing Python dependencies (first run – this may take a minute)..."
    pip3 install -r "$OCR_DIR/requirements.txt" --quiet
  fi
fi

# ── MongoDB check ─────────────────────────────────────────────────────────────
if ! pgrep -x mongod >/dev/null 2>&1; then
  warn "MongoDB not running. Attempting to start..."
  if command -v mongod >/dev/null 2>&1; then
    mongod --fork --logpath /tmp/mongod.log --dbpath /data/db 2>/dev/null || \
    mongod --fork --logpath /tmp/mongod.log 2>/dev/null || \
    warn "Could not start MongoDB automatically. Please start it manually."
  else
    warn "mongod not found. Make sure MongoDB is running on 127.0.0.1:27017"
  fi
fi

# ── start Python OCR service ──────────────────────────────────────────────────
if ! $NO_OCR; then
  # Kill any stale OCR service
  pkill -f "python3 main.py" 2>/dev/null || true
  sleep 0.5

  log "Starting Python OCR service (Gemini Vision) on port 5050..."
  (cd "$OCR_DIR" && python3 main.py > /tmp/ocr_service.log 2>&1) &
  OCR_PID=$!
  PIDS+=("$OCR_PID")

  # Wait for it to be ready (up to 12s)
  OCR_READY=false
  for i in {1..12}; do
    sleep 1
    if curl -s http://localhost:5050/health >/dev/null 2>&1; then
      OCR_READY=true
      break
    fi
  done

  if $OCR_READY; then
    GEMINI_STATUS=$(curl -s http://localhost:5050/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('✓ Gemini configured' if d.get('gemini_configured') else '⚠  Gemini API key missing')" 2>/dev/null || echo "")
    ok "Python OCR service running on http://localhost:5050  $GEMINI_STATUS"
  else
    warn "Python OCR service did not start in time. Check /tmp/ocr_service.log"
    warn "Continuing without Gemini Vision OCR (Tesseract fallback active)"
  fi
fi

# ── start Node.js backend ─────────────────────────────────────────────────────
log "Starting Node.js backend..."
(cd "$BACKEND_DIR" && npm start 2>&1) &
BACKEND_PID=$!
PIDS+=("$BACKEND_PID")

# Wait for backend (up to 15s)
BACKEND_PORT=${PORT:-5001}
BACKEND_READY=false
for i in {1..15}; do
  sleep 1
  if curl -s "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1 || \
     curl -s "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1; then
    BACKEND_READY=true
    break
  fi
done

$BACKEND_READY && ok "Backend running on http://localhost:$BACKEND_PORT" || warn "Backend may still be starting..."

# ── start frontend ────────────────────────────────────────────────────────────
if ! $NO_UI; then
  log "Starting frontend (Vite) ..."
  if $PROD; then
    (cd "$FRONTEND_DIR" && npm run build && npm run preview 2>&1) &
  else
    (cd "$FRONTEND_DIR" && npm run dev 2>&1) &
  fi
  FRONTEND_PID=$!
  PIDS+=("$FRONTEND_PID")
  sleep 3
  ok "Frontend starting on http://localhost:5173"
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  MedVision is running${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
! $NO_OCR  && echo -e "  🐍 Python OCR   →  http://localhost:5050/health"
            echo -e "  🟢 Backend       →  http://localhost:$BACKEND_PORT"
! $NO_UI   && echo -e "  ⚡  Frontend      →  http://localhost:5173"
echo ""
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop all services"
echo ""

# ── wait forever ─────────────────────────────────────────────────────────────
wait
