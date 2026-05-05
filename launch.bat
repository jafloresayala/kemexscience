@echo off
title PI Foundry Agent
color 02

echo.
echo  +======================================+
echo  ^|    PI FOUNDRY AGENT  ^|  LAUNCHER     ^|
echo  +======================================+
echo.

:: ── Verificar Python ──────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python no encontrado.
    echo  Instala Python 3.10+ desde https://python.org
    pause
    exit /b 1
)

:: ── Verificar archivo .env ────────────────────────────────
if not exist .env (
    echo  [ERROR] Falta el archivo .env en esta carpeta.
    echo.
    echo  Crea un archivo llamado ".env" con el siguiente contenido:
    echo.
    echo    PROJECT_ENDPOINT=https://^<recurso^>.services.ai.azure.com/api/projects/^<proyecto^>
    echo    MODEL_DEPLOYMENT_NAME=^<nombre-del-deployment^>
    echo.
    pause
    exit /b 1
)

:: ── Instalar dependencias si falta textual ────────────────
python -c "import textual" >nul 2>&1
if errorlevel 1 (
    echo  Instalando dependencias por primera vez...
    echo.
    pip install -r requirements.txt -q
    if errorlevel 1 (
        echo  [ERROR] Fallo la instalacion de dependencias.
        pause
        exit /b 1
    )
    echo  Dependencias instaladas correctamente.
    echo.
)

:: ── Verificar autenticacion Azure ────────────────────────
az --version >nul 2>&1
if errorlevel 1 (
    echo  [AVISO] Azure CLI (az) no encontrado en PATH.
    echo  Si tu .env tiene AZURE_TENANT_ID, AZURE_CLIENT_ID y AZURE_CLIENT_SECRET,
    echo  la app usara Service Principal y no necesitas az login.
    echo  Si no tienes esas variables, instala Azure CLI:
    echo    https://aka.ms/installazurecliwindows
    echo.
) else (
    az account show >nul 2>&1
    if errorlevel 1 (
        echo  [AVISO] No hay sesion activa de Azure CLI.
        echo  Si no usas Service Principal en el .env, ejecuta: az login
        echo.
    ) else (
        echo  [OK] Sesion Azure CLI activa.
        echo.
    )
)

:: ── Iniciar aplicacion ────────────────────────────────────
echo  Iniciando PI Foundry Agent...
echo.
python app_ui.py

:: ── Manejo de error al salir ──────────────────────────────
if errorlevel 1 (
    echo.
    echo  [ERROR] La aplicacion termino con error.
    echo  Asegurate de haber ejecutado: az login
    echo.
    pause
)
