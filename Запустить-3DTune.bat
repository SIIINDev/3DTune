@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 3DTune

rem One-click launcher for Windows. Deliberately plain: no installer, no admin rights, no PATH
rem changes, no services. It checks what a first run needs, installs dependencies once, then starts
rem the host bound to the local network and opens the browser.

cd /d "%~dp0"

echo ============================================
echo  3DTune - управление Kingroon KP5L
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден.
  echo.
  echo 3DTune запускает TypeScript напрямую, поэтому нужен свежий Node.js.
  echo   1. Открой https://nodejs.org
  echo   2. Скачай LTS-версию для Windows и установи ^(галочки менять не нужно^)
  echo   3. Закрой это окно и запусти файл снова
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if !NODEMAJOR! LSS 24 (
  echo [ОШИБКА] Установлен Node.js версии !NODEMAJOR!, нужна 24 или новее.
  echo Обнови Node.js с https://nodejs.org и запусти файл снова.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Первый запуск: устанавливаю зависимости. Это делается один раз и займёт минуту.
  echo.
  call npm ci --omit=dev
  if errorlevel 1 (
    echo.
    echo [ОШИБКА] Установка зависимостей не удалась.
    echo Проверь интернет и попробуй снова. Если не помогает - удали папку node_modules.
    echo.
    pause
    exit /b 1
  )
  echo.
)

echo Проверяю готовность...
echo.
call node bin\3dtune.mjs --doctor
if errorlevel 1 (
  echo.
  echo Запуск остановлен: сначала исправь пункты со словом СБОЙ выше.
  echo.
  pause
  exit /b 1
)

echo.
echo --------------------------------------------
echo  Если Windows спросит про доступ для Node.js
echo  - разреши для ЧАСТНЫХ сетей. Без этого
echo  телефон и мак не смогут подключиться.
echo --------------------------------------------
echo.
echo Закрыть 3DTune: закрой это окно или нажми Ctrl+C.
echo.

call node bin\3dtune.mjs --host 0.0.0.0 --open %*

echo.
echo 3DTune остановлен.
pause
