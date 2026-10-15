@echo off
title G86 - Local Dev Starter
echo ========================================================
echo       G86 - MEDIU DE DEZVOLTARE ULTRA-RAPID PC
echo ========================================================
echo.
echo Pornire PocketBase Engine (127.0.0.1:8090)...
start "G86 - PocketBase Core" /min cmd /c "cd /d "%~dp0local-dev" && pocketbase.exe serve --dir pb_data --http 127.0.0.1:8090"

timeout /t 1 /nobreak >nul

echo Pornire Backend Phone Dashboard (http://localhost:8787)...
start "G86 - Backend (8787)" /min cmd /c "cd /d "%~dp0local-dev" && python backend_server.py"

echo Pornire Frontend Web App (http://localhost:8686)...
start "G86 - Frontend (8686)" /min cmd /c "cd /d "%~dp0local-dev" && python dev_server.py"

timeout /t 1 /nobreak >nul

echo.
echo ========================================================
echo   [OK] Serverele sunt active:
echo   - Backend Phone UI:  http://localhost:8787
echo   - Frontend Client:   http://localhost:8686
echo ========================================================
echo Deschid browserul...
start http://localhost:8787
start http://localhost:8686
