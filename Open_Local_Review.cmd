@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>&1
if not errorlevel 1 goto use_py
where python >nul 2>&1
if not errorlevel 1 goto use_python
echo Python was not found. Use the same Python installation that ran your notebook.
echo Read START_HERE.md for the manual command and setup steps.
goto done
:use_py
py -3 scripts\review_locally.py
goto done
:use_python
python scripts\review_locally.py
:done
pause
