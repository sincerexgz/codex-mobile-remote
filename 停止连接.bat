@echo off
cd /d "%~dp0"
chcp 65001 >nul
set "CONNECTOR_NODE=%~dp0runtime\node.exe"
if not exist "%CONNECTOR_NODE%" set "CONNECTOR_NODE=node.exe"
"%CONNECTOR_NODE%" "%~dp0pair-agent.mjs" --stop
pause
