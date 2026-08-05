#!/bin/bash
# One-click launcher for macOS. Same contract as the Windows .bat: no installer, no admin rights.
cd "$(dirname "$0")" || exit 1

echo "============================================"
echo " 3DTune — управление Kingroon KP5L"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ОШИБКА] Node.js не найден."
  echo
  echo "  1. Открой https://nodejs.org и установи LTS-версию для macOS"
  echo "  2. Закрой это окно и запусти файл снова"
  echo
  read -r -p "Enter для выхода..." _
  exit 1
fi

major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 24 ]; then
  echo "[ОШИБКА] Установлен Node.js $major, нужна 24 или новее."
  echo "Обнови с https://nodejs.org и запусти снова."
  read -r -p "Enter для выхода..." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю зависимости. Один раз, около минуты."
  echo
  npm ci --omit=dev || {
    echo
    echo "[ОШИБКА] Установка не удалась. Проверь интернет и попробуй снова."
    read -r -p "Enter для выхода..." _
    exit 1
  }
  echo
fi

echo "Проверяю готовность..."
echo
node bin/3dtune.mjs --doctor || {
  echo
  echo "Запуск остановлен: исправь пункты со словом СБОЙ выше."
  read -r -p "Enter для выхода..." _
  exit 1
}

echo
echo "Закрыть 3DTune: закрой это окно или нажми Ctrl+C."
echo
node bin/3dtune.mjs --host 0.0.0.0 --open "$@"

echo
echo "3DTune остановлен."
read -r -p "Enter для выхода..." _
