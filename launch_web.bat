@echo off
title KEMEX SCIENCE - PI Foundry Web
color 02
cd /d "%~dp0"

echo.
echo  +============================================+
echo  ^|   KEMEX SCIENCE  ^|  PI FOUNDRY WEB  v1.0  ^|
echo  ^|        POWERED BY Jose Alfredo             ^|
echo  +============================================+
echo.

:: ── Detectar Python ───────────────────────────────────────────────────────────
set PYTHON_CMD=
python --version >nul 2>&1
if not errorlevel 1 set PYTHON_CMD=python
if "%PYTHON_CMD%"=="" (
    py --version >nul 2>&1
    if not errorlevel 1 set PYTHON_CMD=py
)
if "%PYTHON_CMD%"=="" (
    echo  [ERROR] Python no encontrado en PATH.
    echo  Instala Python 3.10+ desde https://python.org
    pause
    exit /b 1
)
echo  [OK] Python detectado ^(%PYTHON_CMD%^)

:: ── Verificar .env ────────────────────────────────────────────────────────────
if not exist ".env" (
    echo  [ERROR] Falta el archivo .env en esta carpeta.
    pause
    exit /b 1
)
echo  [OK] Archivo .env encontrado.

:: ── Instalar dependencias Python ─────────────────────────────────────────────
echo  Verificando dependencias Python...
%PYTHON_CMD% -c "import fastapi, uvicorn, azure.identity, openai, matplotlib" >nul 2>&1
if errorlevel 1 (
    echo  Instalando dependencias Python ^(primera instalacion^)...
    %PYTHON_CMD% -m pip install --upgrade pip >nul 2>&1
    %PYTHON_CMD% -m pip install -r requirements.txt
    if errorlevel 1 (
        echo  [ERROR] Fallo pip install. Revisa requirements.txt y tu conexion.
        pause
        exit /b 1
    )
    echo  [OK] Dependencias instaladas correctamente.
) else (
    echo  [OK] Dependencias listas.
)

:: ── Build frontend si no existe ──────────────────────────────────────────────
if exist "frontend\dist\index.html" (
    echo  [OK] Frontend ya construido.
    goto :start_server
)

node --version >nul 2>&1
if errorlevel 1 (
    echo  [AVISO] Node.js no encontrado - iniciando solo como API.
    echo          Instala Node.js en https://nodejs.org para activar la UI.
    goto :start_server
)
for /f "tokens=*" %%v in ('node --version 2^>^&1') do echo  [OK] Node.js %%v
echo  Construyendo frontend React ^(primera vez, puede tardar^)...
cd frontend
call npm install
if errorlevel 1 (
    echo  [ERROR] npm install fallo.
    cd ..
    pause
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo  [ERROR] npm run build fallo.
    cd ..
    pause
    exit /b 1
)
cd ..
echo  [OK] Frontend construido.

:: ── Arrancar servidor ────────────────────────────────────────────────────────
:start_server

:: Obtener IP local de red
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set LOCAL_IP=%%a
    goto :got_ip
)
:got_ip
set LOCAL_IP=%LOCAL_IP: =%

echo.
echo  ============================================================
echo   Local:    http://localhost:7860
echo   Red LAN:  http://%LOCAL_IP%:7860
echo.
echo   Comparte la direccion LAN con otros equipos de la red.
echo   Presiona Ctrl+C para detener el servidor.
echo  ============================================================
echo.

start "" /min cmd /c "timeout /t 4 /nobreak >nul && start http://localhost:7860"
%PYTHON_CMD% server.py

echo.
echo  Servidor detenido.
pause
