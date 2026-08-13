#!/usr/bin/env bash
set -euo pipefail

export SOFTHSM_DATA_DIR="${SOFTHSM_DATA_DIR:-/data/softhsm}"
mkdir -p "$SOFTHSM_DATA_DIR"

if [[ -z "${SOFTHSM_MODULE_PATH:-}" || ! -f "${SOFTHSM_MODULE_PATH}" ]]; then
  export SOFTHSM_MODULE_PATH="$(find /usr -name 'libsofthsm2.so' 2>/dev/null | head -1)"
fi

# Run init; export SOFTHSM_* lines into this shell (pipefail so init failures abort).
while IFS= read -r line; do
  case "$line" in
    SOFTHSM*=*)
      export "$line"
      ;;
  esac
done < <(./scripts/init-softhsm.sh)

exec "$@"
