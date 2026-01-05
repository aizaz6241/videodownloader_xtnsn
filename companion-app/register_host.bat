@echo off
set "HOST_NAME=com.streamsniffer.pro"
set "MANIFEST_PATH=%~dp0native-manifest.json"

:: Create Registry Key
REG ADD "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f

echo.
echo Host registered successfully!
echo Manifest: %MANIFEST_PATH%
echo.
pause
