#!/usr/bin/env bash
# Checksum da assinatura para o QR de provisionamento:
# PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM = base64url(SHA-256 do certificado de assinatura), sem padding.
# Uso: android/scripts/signature-checksum.sh app-release.apk   (requer build-tools no ANDROID_HOME)
set -euo pipefail
APK="$1"
BT="$(ls -d "${ANDROID_HOME:?defina ANDROID_HOME}"/build-tools/* | sort -V | tail -1)"
SIGNER="$BT/apksigner"; [ -x "$SIGNER" ] || SIGNER="$BT/apksigner.bat"
HEX=$("$SIGNER" verify --print-certs "$APK" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -1 | tr -d '')
[ -n "$HEX" ] || { echo "APK sem assinatura válida" >&2; exit 1; }
echo "sha256 do certificado: $HEX"
printf '%s' "$HEX" | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='
echo
