@echo off
title FAFO Match
cd /d "%~dp0"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo Python 3 was not found. Install it from python.org, then run this again.
  pause
  exit /b 1
)
echo FAFO Match is starting. Close the browser tab and this window stops about a minute later.
start "" "http://127.0.0.1:18766/"
%PY% "%~dp0server\match_server.py"
echo Server stopped.
