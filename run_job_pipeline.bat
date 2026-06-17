@echo off
:: run_job_pipeline.bat - Helper script for the Job Application Pipeline
:: ------------------------------------------------------------
:: Usage:
::   run_job_pipeline.bat run        - Starts the backend server (node backend/server.js)
::   run_job_pipeline.bat check      - Checks if any source files have changed since the last run
::   run_job_pipeline.bat help       - Shows this help message

setlocal EnableDelayedExpansion

rem Directory containing the project (assumes script is placed in the project root)
set "PROJECT_ROOT=%~dp0"

rem File that stores the last known SHA256 hashes of watched files
set "HASH_FILE=%PROJECT_ROOT%file_hashes.txt"

rem List of files to watch (add more if needed)
set "WATCHED_FILES=\
%PROJECT_ROOT%config.json ^
%PROJECT_ROOT%backend\server.js ^
%PROJECT_ROOT%backend\llmProvider.js ^
%PROJECT_ROOT%backend\nvidiaProvider.js ^
%PROJECT_ROOT%backend\telegramBot.js ^
%PROJECT_ROOT%scraper.js ^
%PROJECT_ROOT%frontend\src\components\QueueManager.jsx"

rem ------------------------------------------------------------
:: Function: compute current hashes and write to a temp file
:compute_hashes
    set "TMP_HASH=%PROJECT_ROOT%tmp_hashes.txt"
    if exist "%TMP_HASH%" del "%TMP_HASH%"
    for %%F in (%WATCHED_FILES%) do (
        if exist "%%F" (
            powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 \"%%F\").Hash" > "%PROJECT_ROOT%hash_tmp.txt"
            set /p HASH_VAL=<"%PROJECT_ROOT%hash_tmp.txt"
            echo %%F=!HASH_VAL!>>"%TMP_HASH%"
            del "%PROJECT_ROOT%hash_tmp.txt"
        ) else (
            echo FILE_NOT_FOUND: %%F>>"%TMP_HASH%"
        )
    )
    goto :eof

rem ------------------------------------------------------------
:: Function: compare current hashes with stored ones
:compare_hashes
    if not exist "%HASH_FILE%" (
        echo No previous hash file found. Creating one now...>
        call :compute_hashes
        move /Y "%TMP_HASH%" "%HASH_FILE%" >nul
        echo All watched files are now recorded as baseline. No changes detected.
        goto :eof
    )
    call :compute_hashes
    set "CHANGES=0"
    for /F "tokens=1* delims==" %%A in (%HASH_FILE%) do (
        set "OLD_FILE=%%A"
        set "OLD_HASH=%%B"
        for /F "tokens=1* delims==" %%C in (%TMP_HASH%) do (
            if "%%C"=="!OLD_FILE!" (
                if not "%%D"=="!OLD_HASH!" (
                    echo CHANGE DETECTED: !OLD_FILE!
                    set /A CHANGES+=1
                )
            )
        )
    )
    if !CHANGES! EQU 0 (
        echo No changes detected in watched files.
    ) else (
        echo !CHANGES! file(s) have changed. Updating hash baseline.
        move /Y "%TMP_HASH%" "%HASH_FILE%" >nul
    )
    goto :eof

rem ------------------------------------------------------------
if "%1"=="" goto :help
if "%1"=="help" goto :help
if "%1"=="run" goto :run
if "%1"=="check" goto :check

:help
    echo Usage: run_job_pipeline.bat [run|check|help]
    echo   run   - Start the Node backend server.
    echo   check - Compare current file hashes with the stored baseline to detect changes.
    echo   help  - Show this help message.
    exit /B 0

:run
    echo Killing old node processes...
    taskkill /F /IM node.exe > nul 2>&1
    echo Starting backend server... 
    pushd "%PROJECT_ROOT%"
    node backend\server.js
    popd
    exit /B 0

:check
    echo Checking for file changes... 
    call :compare_hashes
    exit /B 0
