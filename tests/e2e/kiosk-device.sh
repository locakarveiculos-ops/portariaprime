#!/usr/bin/env bash
# Laboratório: validação do quiosque no Android gerenciado (emulador ou aparelho de TESTE via adb).
# NUNCA rode em aparelho de cliente. Não faz restauração de fábrica.
# Pré: app de laboratório inscrito (tests/e2e/kiosk-lab-setup.mjs), stack local + dev-stack no ar.
#   bash tests/e2e/kiosk-device.sh   (na raiz do projeto)
set -u
export MSYS_NO_PATHCONV=1
# Helpers de toque/UI (tapText, typeText). Carregado ANTES das funções abaixo, que têm prioridade.
. /j/android-toolchain/lab/ui.sh
# typeChecked (ui.sh): digita e confere o campo antes de enviar; sem isso, um caractere perdido pelo teclado do emulador vira "código errado".
ADB=${ADB:-/j/android-toolchain/sdk/platform-tools/adb.exe}
PKG=br.com.portariaprime.kiosk
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
ko() { echo "  FALHA $1"; fail=$((fail+1)); }
lock() { $ADB shell dumpsys activity activities | grep -oE "mLockTaskModeState=[A-Z]+" | cut -d= -f2; }
top() { $ADB shell dumpsys activity activities | grep -m1 topResumedActivity | grep -oE '[a-z0-9.]+/[A-Za-z0-9.$]+'; }
cmd() { node --env-file=.env.stack.local tests/e2e/kiosk-lab-cmd.mjs "$@"; }
kick() { $ADB shell cmd jobscheduler run -f $PKG 1 >/dev/null 2>&1 || $ADB shell am broadcast -a android.intent.action.BOOT_COMPLETED -p $PKG >/dev/null 2>&1; }
waitlock() { for i in $(seq 1 ${2:-40}); do [ "$(lock)" = "$1" ] && return 0; sleep 3; done; return 1; }
net() { if [ "$1" = on ]; then $ADB shell svc wifi enable; $ADB shell svc data enable; $ADB reverse tcp:3017 tcp:3017 >/dev/null; $ADB reverse tcp:54321 tcp:54321 >/dev/null;
        else $ADB reverse --remove-all; $ADB shell svc wifi disable; $ADB shell svc data disable; fi; }
reboot() { $ADB reboot; $ADB wait-for-device; for i in $(seq 1 80); do [ "$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break; sleep 3; done; }
slug=$(node -p "require('./tests/evidence/kiosk-lab.json').slug")

echo "Aparelho: $($ADB shell getprop ro.product.manufacturer | tr -d '\r') $($ADB shell getprop ro.product.model | tr -d '\r') · Android $($ADB shell getprop ro.build.version.release | tr -d '\r') (API $($ADB shell getprop ro.build.version.sdk | tr -d '\r')) · patch $($ADB shell getprop ro.build.version.security_patch | tr -d '\r')"
echo "App: $($ADB shell dumpsys package $PKG | grep -m1 versionName | tr -d ' \r')"

echo "1. Device Owner"
$ADB shell dumpsys device_policy | grep -q "admin=ComponentInfo{$PKG/" && ok "Device Owner = $PKG" || ko "não é Device Owner"
echo "2. Lock Task"
[ "$(lock)" = LOCKED ] && ok "mLockTaskModeState=LOCKED" || ko "Lock Task: $(lock)"
echo "3. Rotas de saída"
for k in KEYCODE_HOME KEYCODE_APP_SWITCH; do $ADB shell input keyevent $k; sleep 2; [ "$(top)" = "$PKG/.KioskActivity" ] && ok "$k mantém o quiosque" || ko "$k → $(top)"; done
$ADB shell am start -a android.settings.SETTINGS >/dev/null 2>&1; sleep 2; [ "$(top)" = "$PKG/.KioskActivity" ] && ok "Configurações bloqueadas" || ko "Configurações abriu: $(top)"
$ADB shell am start -a android.intent.action.VIEW -d https://example.com >/dev/null 2>&1; sleep 2; [ "$(top)" = "$PKG/.KioskActivity" ] && ok "link externo (intent) bloqueado" || ko "link externo: $(top)"
$ADB shell monkey -p com.android.contacts -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 2; [ "$(top)" = "$PKG/.KioskActivity" ] && ok "outro app bloqueado" || ko "outro app: $(top)"
$ADB shell cmd statusbar expand-notifications; sleep 1; $ADB shell dumpsys window | grep -m1 mCurrentFocus | grep -q "$PKG" && ok "barra de notificações sem foco" || ko "barra de notificações abriu"; $ADB shell cmd statusbar collapse

echo "4. Reboot com internet"
reboot; net on; waitlock LOCKED 20 && ok "após reboot: LOCKED em $(top)" || ko "após reboot: $(lock)"
sleep 8; u=$(node 'J:/android-toolchain/lab/cdp-url.mjs' 2>/dev/null); echo "     URL: ${u:-indisponível}"

echo "5. Reboot sem internet"
net off; reboot; $ADB shell svc wifi disable; $ADB shell svc data disable
waitlock LOCKED 20 && ok "sem internet: LOCKED" || ko "sem internet: $(lock)"
sleep 15; $ADB exec-out screencap -p > tests/evidence/emu-40-boot-offline.png
net on

echo "6. Manutenção autorizada pelo síndico (painel) e encerramento manual"
cmd maint 5 >/dev/null; kick
waitlock NONE 20 && ok "manutenção aplicada (Lock Task NONE)" || ko "manutenção não aplicada"
r=$($ADB shell dumpsys user | grep -m1 -A12 "Effective restrictions" | grep -oE "no_[a-z_]+" | tr '\n' ' ')
echo "$r" | grep -q no_factory_reset && ok "na manutenção, restauração de fábrica continua bloqueada" || ko "no_factory_reset caiu na manutenção"
echo "$r" | grep -q no_install_apps && ko "instalação continua bloqueada na manutenção" || ok "instalação liberada na manutenção"
$ADB shell am start -a android.settings.SETTINGS >/dev/null 2>&1; sleep 2; echo "$(top)" | grep -q settings && ok "Configurações acessíveis na manutenção" || ko "Configurações: $(top)"
cmd end >/dev/null; kick
waitlock LOCKED 20 && ok "encerrada pelo painel → LOCKED" || ko "encerrar: $(lock)"

echo "7. Expiração (manutenção de 5 min sem encerrar)"
cmd maint 5 >/dev/null; kick; waitlock NONE 20
t0=$(date +%s); waitlock LOCKED 140 && ok "voltou sozinho em $(( $(date +%s)-t0 ))s (prazo 300s)" || ko "não voltou no prazo"

echo "8. Reinício durante manutenção"
cmd maint 30 >/dev/null; kick; waitlock NONE 20 && ok "em manutenção" || ko "não entrou"
reboot; net on; waitlock LOCKED 20 && ok "após reboot durante manutenção: LOCKED" || ko "após reboot: $(lock)"

echo "9. Recuperação offline (código descartável)"
codes=$(node --env-file=.env.stack.local --import tsx tests/e2e/kiosk-lab-cmd.mjs recovery | grep -oE '"codes":\[[^]]*' | grep -oE '[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}')
kick; sleep 10   # aparelho recebe os hashes antes de ficar offline
c1=$(echo "$codes" | sed -n 1p)
net off; sleep 2
tapText "Manutenção" >/dev/null; sleep 2; tapText "Código de recuperação" >/dev/null; typeChecked "$c1"; tapText "VALIDAR" >/dev/null; sleep 5
[ "$(lock)" = NONE ] && ok "código válido offline → manutenção" || ko "código offline: $(lock)"
$ADB shell am start -n $PKG/.KioskActivity >/dev/null 2>&1; sleep 2; tapText "Encerrar manutenção agora" >/dev/null; sleep 4
[ "$(lock)" = LOCKED ] && ok "encerrada no aparelho → LOCKED" || ko "encerrar offline: $(lock)"
tapText "Manutenção" >/dev/null; sleep 2; tapText "Código de recuperação" >/dev/null; typeChecked "$c1"; tapText "VALIDAR" >/dev/null; sleep 4
[ "$(lock)" = LOCKED ] && ok "mesmo código não vale duas vezes" || ko "código reutilizado liberou"
net on; kick; sleep 12
cmd events 8 | grep -q "maintenance.offline_start" && ok "evento offline sincronizado ao reconectar" || ko "evento offline não chegou"

echo
echo "Resultado: $pass PASS, $fail FALHA"
[ $fail -eq 0 ]
