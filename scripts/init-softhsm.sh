#!/usr/bin/env bash
set -euo pipefail

# Minimal SoftHSM2 token + secp256k1 key for the custody signer lab.

DATA_DIR="${SOFTHSM_DATA_DIR:-./data/softhsm}"
PIN="${SOFTHSM_PIN:-1234}"
SO_PIN="${SOFTHSM_SO_PIN:-1234}"
LABEL="${SOFTHSM_KEY_LABEL:-custody-eth}"
TOKEN_LABEL="${SOFTHSM_TOKEN_LABEL:-custody}"

mkdir -p "$DATA_DIR/tokens"
CONF="$DATA_DIR/softhsm2.conf"
cat >"$CONF" <<EOF
directories.tokendir = $DATA_DIR/tokens
objectstore.backend = file
log.level = ERROR
EOF
export SOFTHSM2_CONF="$CONF"

MODULE="${SOFTHSM_MODULE_PATH:-}"
if [[ -z "$MODULE" ]]; then
  MODULE="$(find /usr /opt /opt/homebrew /usr/local -name 'libsofthsm2.so' 2>/dev/null | head -1 || true)"
fi
if [[ -z "$MODULE" || ! -f "$MODULE" ]]; then
  echo "libsofthsm2.so not found. Install SoftHSM2 or set SOFTHSM_MODULE_PATH." >&2
  exit 1
fi
export SOFTHSM_MODULE_PATH="$MODULE"

if ! softhsm2-util --show-slots 2>/dev/null | grep -q "Label:.*${TOKEN_LABEL}"; then
  softhsm2-util --init-token --free --label "$TOKEN_LABEL" --pin "$PIN" --so-pin "$SO_PIN"
fi

# PKCS#11 slot id for pkcs11-tool (not the graphene array index).
SLOT_ID="$(softhsm2-util --show-slots | awk -v label="$TOKEN_LABEL" '
  /^Slot / { slot=$2 }
  /Label:/ {
    lbl=$0
    sub(/^[^:]*:[[:space:]]*/, "", lbl)
    gsub(/[[:space:]]+$/, "", lbl)
    if (lbl == label) { print slot; exit }
  }
')"
if [[ -z "${SLOT_ID:-}" ]]; then
  echo "Could not resolve SoftHSM slot for token label=$TOKEN_LABEL" >&2
  softhsm2-util --show-slots >&2 || true
  exit 1
fi

if ! pkcs11-tool --module "$MODULE" --slot "$SLOT_ID" --login --pin "$PIN" -O 2>/dev/null | grep -q "$LABEL"; then
  pkcs11-tool --module "$MODULE" --slot "$SLOT_ID" --login --pin "$PIN" \
    --keypairgen --key-type EC:secp256k1 --label "$LABEL" --id 01
fi

# App uses graphene slot *index* among token-present slots (usually 0).
echo "SOFTHSM2_CONF=$CONF"
echo "SOFTHSM_MODULE_PATH=$MODULE"
echo "SOFTHSM_SLOT=0"
echo "SOFTHSM_PIN=$PIN"
echo "SOFTHSM_KEY_LABEL=$LABEL"
