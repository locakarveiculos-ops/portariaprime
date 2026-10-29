#!/usr/bin/env bash
# Laboratório (emulador ou aparelho de TESTE dedicado): saídas do quiosque.
#  A. código de recuperação errado: limite de tentativas, bloqueio e reboot (não fura o bloqueio);
#  B. versão sem testOnly recusa a remoção por cabo (dpm remove-active-admin);
#  C. desativação pelo painel com o aparelho SEM conexão (fica pendente, nada é liberado) e depois com conexão:
#     conferido no Android (sem Device Owner, sem restrições, sem Lock Task, desinstalável) e no painel;
#  D. variante lab (testOnly): ADB ativo com quiosque e após reboot; recuperação por cabo; registro no painel
#     por "liberação local verificada" (aparelho fora do ar);
#  E. dados do aparelho preservados em todos os fluxos (arquivo-sentinela em /data/local/tmp, apagado por restauração de fábrica).
# Ao final o laboratório volta ao estado inicial (lab instalado como Device Owner, inscrito e em quiosque).
# NUNCA em aparelho de cliente nem no celular pessoal. Não faz restauração de fábrica.
# Pré: stack local + dev-stack, app lab inscrito, sem contas no aparelho. Uso: bash tests/e2e/kiosk-exit.sh
set -u
export MSYS_NO_PATHCONV=1
. /j/android-toolchain/lab/ui.sh
ADB=${ADB:-/j/android-toolchain/sdk/platform-tools/adb.exe}
PKG=br.com.portariaprime.kiosk
ADMIN=$PKG/.admin.KioskAdminReceiver
LAB_APK=${LAB_APK:-'J:\android-toolchain\lab\app-lab.apk'}
pass=0; fail=0
ok() { echo "  PASS  $1"; pass=$((pass+1)); }
ko() { echo "  FALHA $1"; fail=$((fail+1)); }
lock() { $ADB shell dumpsys activity activities | grep -oE "mLockTaskModeState=[A-Z]+" | cut -d= -f2; }
owner() { $ADB shell dumpsys device_policy | grep -q "admin=ComponentInfo{$PKG/" && echo sim || echo nao; }
restr() { $ADB shell dumpsys user | grep -m1 -A20 "Effective restrictions" | grep -oE "^ +no_[a-z_]+" | tr -d ' ' | tr '\n' ' '; }
cmd() { node --env-file=.env.stack.local tests/e2e/kiosk-lab-cmd.mjs "$@"; }
state() { cmd state | grep -oE '"state": "[a-z_]+"' | cut -d'"' -f4; }
prefs() { $ADB shell run-as $PKG cat shared_prefs/kiosk.xml 2>/dev/null; }
kick() { $ADB shell cmd jobscheduler run -f $PKG 1 >/dev/null 2>&1 || { $ADB shell am force-stop $PKG; $ADB shell am start -n $PKG/.KioskActivity >/dev/null 2>&1; }; }
waitlock() { for i in $(seq 1 ${2:-30}); do [ "$(lock)" = "$1" ] && return 0; sleep 3; done; return 1; }
waitstate() { for i in $(seq 1 ${2:-20}); do [ "$(state)" = "$1" ] && return 0; kick; sleep 4; done; return 1; }
net() { if [ "$1" = on ]; then $ADB shell svc wifi enable; $ADB shell svc data enable; sleep 3; $ADB reverse tcp:3017 tcp:3017 >/dev/null; $ADB reverse tcp:54321 tcp:54321 >/dev/null;
        else $ADB reverse --remove-all; $ADB shell svc wifi disable; $ADB shell svc data disable; fi; }
reboot() { $ADB reboot; $ADB wait-for-device; for i in $(seq 1 80); do [ "$($ADB shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break; sleep 3; done; }
sentinel_ok() { [ "$($ADB shell cat /data/local/tmp/pp-sentinela.txt 2>/dev/null | tr -d '\r')" = "$SENT" ]; }
# Digita e confere o que ficou no campo antes de enviar (o teclado às vezes perde caracteres).
enroll_ui() {
  for t in 1 2 3; do
    tok=$(cmd enroll)
    for i in $(seq 1 15); do ui 40 | grep -q 'Código de inscrição' && break; sleep 2; done
    tapText "Código de inscrição" >/dev/null; $ADB shell input keyevent KEYCODE_MOVE_END; for k in $(seq 1 30); do $ADB shell input keyevent KEYCODE_DEL; done
    typeText "$tok"; sleep 1
    $ADB shell uiautomator dump /data/local/tmp/ui.xml >/dev/null; got=$($ADB shell cat /data/local/tmp/ui.xml | grep -oE 'text="[A-Z0-9]{24}"' | head -1 | cut -d'"' -f2)
    [ "$got" = "$tok" ] || continue
    tapText "Inscrever" >/dev/null
    for i in $(seq 1 20); do prefs | grep -q 'name="revoked" value="false"' && prefs | grep -q device_id && return 0; sleep 2; done
  done; return 1; }
provision_lab() {   # instala a variante lab e a torna Device Owner pelo comando de laboratório (sem restauração)
  $ADB install -t "$LAB_APK" > /tmp/inst.txt 2>&1; grep -q Success /tmp/inst.txt || { cat /tmp/inst.txt | tail -2; return 1; }
  $ADB shell dpm set-device-owner $ADMIN > /tmp/do.txt 2>&1; grep -qi success /tmp/do.txt || { cat /tmp/do.txt | tail -3; return 1; }
  $ADB shell am start -n $PKG/.KioskActivity >/dev/null 2>&1
  cmd newdevice >/dev/null && enroll_ui && waitlock LOCKED 30; }

net on
SENT="pp-$(date +%s)"; $ADB shell "echo $SENT > /data/local/tmp/pp-sentinela.txt"   # /sdcard fica fechado ao shell com no_usb_file_transfer; /data/local/tmp também some na restauração
echo "Aparelho: $($ADB shell getprop ro.product.model | tr -d '\r') · Android $($ADB shell getprop ro.build.version.release | tr -d '\r') · app $($ADB shell dumpsys package $PKG | grep -m1 versionName | tr -d ' \r')"
DEV0=$(prefs | grep -oE 'name="device_id">[^<]+' | cut -d'>' -f2)

echo "A. Código de recuperação incorreto e limite de tentativas"
codes=$(node --env-file=.env.stack.local --import tsx tests/e2e/kiosk-lab-cmd.mjs recovery | grep -oE '[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}')
good=$(echo "$codes" | sed -n 2p); kick; sleep 10
try_code() { tapText "Manutenção" >/dev/null; sleep 2; tapText "Código de recuperação" >/dev/null; typeChecked "$1"; tapText "VALIDAR" >/dev/null; sleep 4; }
for i in 1 2 3 4 5; do try_code "ZZZZ-ZZZZ-ZZZ$i"; done
[ "$(lock)" = LOCKED ] && ok "5 códigos errados: continua em quiosque" || ko "código errado liberou: $(lock)"
prefs | grep -q 'name="att_fail" value="5"' && ok "5 falhas contadas no aparelho" || ko "falhas: $(prefs | grep -oE 'att_fail" value="[0-9]+')"
try_code "$good"
[ "$(lock)" = LOCKED ] && ok "bloqueado: até o código CERTO é recusado" || ko "código certo passou durante o bloqueio"
reboot; net on; waitlock LOCKED 20
try_code "$good"
[ "$(lock)" = LOCKED ] && ok "reboot não fura o bloqueio" || ko "reboot liberou tentativas"
kick; sleep 10
ev=$(cmd events 30); echo "$ev" | grep -q "recovery.failed" && echo "$ev" | grep -q "recovery.locked" && ok "falhas e bloqueio registrados no painel" || ko "eventos de tentativa não chegaram"
cmd maint 5 >/dev/null; kick; waitlock NONE 20 && ok "com o código bloqueado, a manutenção pelo painel continua disponível" || ko "manutenção pelo painel: $(lock)"
cmd end >/dev/null; kick; waitlock LOCKED 20 || ko "não voltou ao quiosque"
sentinel_ok && ok "dados preservados (A)" || ko "sentinela alterada (A)"

echo "B. Versão sem testOnly não sai por cabo"
if $ADB shell dumpsys device_policy | grep -q "testOnlyAdmin=false"; then
  $ADB shell dpm remove-active-admin $ADMIN > /tmp/rm.txt 2>&1
  [ "$(owner)" = sim ] && ok "remove-active-admin recusado (admin não-testOnly): $(grep -oE 'SecurityException[^\r]{0,60}' /tmp/rm.txt | head -1)" || ko "admin não-testOnly saiu por cabo"
else echo "  (pulado: admin atual já é testOnly)"; fi

echo "C. Desativação pelo painel"
net off; cmd deactivate >/dev/null; kick; sleep 15
[ "$(owner)" = sim ] && [ "$(lock)" = LOCKED ] && ok "sem conexão: aparelho continua gerenciado e em quiosque" || ko "sem conexão: owner=$(owner) lock=$(lock)"
net on; sleep 3
[ "$(state)" = desativacao_pendente ] && ok "painel: desativação pendente até o aparelho confirmar" || ko "painel: $(state)"
waitstate desativado 25 && ok "painel: desativado após confirmação do aparelho" || ko "painel não confirmou: $(state)"
[ "$(owner)" = nao ] && ok "Android: Device Owner removido" || ko "Android: ainda Device Owner"
r=$(restr); echo "     restrições efetivas: ${r:-nenhuma}"
echo "$r" | grep -qE "no_(install_apps|uninstall_apps|factory_reset|add_user|modify_accounts|safe_boot|usb_file_transfer|install_unknown_sources)" && ko "restrições do Portaria Prime ficaram" || ok "Android: restrições do Portaria Prime removidas"
[ "$(lock)" = NONE ] && ok "Android: Lock Task encerrado" || ko "Lock Task: $(lock)"
$ADB shell am start -a android.settings.SETTINGS >/dev/null 2>&1; sleep 3
$ADB shell dumpsys activity activities | grep -m1 topResumedActivity | grep -q settings && ok "Configurações abrem normalmente" || ko "Configurações não abriram"
$ADB shell am start -n $PKG/.KioskActivity >/dev/null 2>&1; sleep 3
ui 20 | grep -q "Gerenciamento retirado" && ok "app mostra 'Gerenciamento retirado'" || ko "tela pós-desativação ausente"; shot 51-gerenciamento-retirado
prefs | grep -q 'name="revoked" value="true"' && ok "agente parou de sincronizar (credencial revogada)" || ko "agente ainda ativo"
sentinel_ok && ok "dados preservados (C)" || ko "sentinela alterada (C)"
$ADB shell pm uninstall $PKG | grep -q Success && ok "app desinstalado sem restauração" || ko "desinstalação recusada"

echo "D. Variante lab: ADB com quiosque, reboot e recuperação por cabo"
provision_lab && ok "lab: Device Owner por cabo + inscrição + quiosque" || ko "lab: provisionamento falhou"
$ADB shell dumpsys device_policy | grep -q "testOnlyAdmin=true" && ok "lab: admin testOnly" || ko "lab: admin não é testOnly"
$ADB shell dumpsys user | grep -m1 -A20 "Effective restrictions" | grep -q no_debugging_features && ko "lab: ADB bloqueado" || ok "lab: ADB não é desligado pela política"
reboot; net on
$ADB shell echo vivo | grep -q vivo && ok "lab: ADB acessível após reboot" || ko "lab: ADB inacessível após reboot"
waitlock LOCKED 20 && ok "lab: após reboot volta ao quiosque" || ko "lab: após reboot $(lock)"
$ADB shell dpm remove-active-admin $ADMIN > /tmp/rm.txt 2>&1
grep -qi success /tmp/rm.txt && [ "$(owner)" = nao ] && ok "lab: dpm remove-active-admin removeu o Device Owner" || ko "lab: remoção por cabo: $(tail -c 120 /tmp/rm.txt)"
sleep 3; r=$(restr); echo "     restrições efetivas após remoção por cabo: ${r:-nenhuma}"
echo "$r" | grep -qE "no_(install_apps|uninstall_apps|factory_reset|add_user|modify_accounts|safe_boot|usb_file_transfer)" && ko "restrições ficaram após remoção por cabo" || ok "lab: restrições removidas pelo Android"
[ "$(lock)" = NONE ] || { $ADB shell input keyevent KEYCODE_HOME; sleep 2; }
echo "     Lock Task após remoção por cabo: $(lock)"
$ADB shell pm uninstall $PKG | grep -q Success && ok "lab: app desinstalado" || ko "lab: desinstalação recusada"
[ "$(lock)" = NONE ] && ok "lab: Lock Task encerrado" || ko "lab: Lock Task $(lock)"
sentinel_ok && ok "dados preservados (D)" || ko "sentinela alterada (D)"
cmd deactivate >/dev/null 2>&1; cmd confirmlocal >/dev/null && [ "$(state)" = desativado ] && ok "painel: liberação local verificada registrada (aparelho fora do ar)" || ko "painel: confirmação local $(state)"

echo "Restaurando o laboratório"
provision_lab && ok "laboratório restaurado (lab, Device Owner, inscrito, LOCKED)" || ko "laboratório não restaurado"
$ADB shell rm -f /data/local/tmp/pp-sentinela.txt
echo; echo "Resultado: $pass PASS, $fail FALHA"
[ $fail -eq 0 ]
