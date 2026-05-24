@echo off
REM Forward Windows terminal usage to the PowerShell implementation.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
