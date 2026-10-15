@echo off
title G86 - Deploy to Phone
echo ========================================================
echo       G86 - SINCRONIZARE RAPIDA PE TELEFON
echo ========================================================
echo.
set ADB="%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"

if not exist %ADB% (
    echo [Eroare] adb.exe nu a fost gasit in %ADB%!
    pause
    exit /b 1
)

echo 1. Trimitere Frontend in /sdcard/g86/public/...
%ADB% push "%~dp0web\." /sdcard/g86/public/

echo 2. Trimitere Backend Dashboard in /sdcard/g86/backend/...
%ADB% push "%~dp0local-dev\pb_backend_public\." /sdcard/g86/backend/

echo Sincronizare si in directorul intern Android (assets fallback)...
copy /Y "%~dp0web\*" "%~dp0android-app\app\src\main\assets\public\" >nul
xcopy /Y /E /I "%~dp0local-dev\pb_backend_public\*" "%~dp0android-app\app\src\main\assets\backend\" >nul

echo.
echo ========================================================
echo   [SUCCES] Toate fisierele web au fost sincronizate!
echo   Poti da refresh in browser pe telefon sau computer.
echo ========================================================
pause
