Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd.exe /c ""set PATH=f:\job\node;%PATH% && cd /d f:\job && node backend\server.js""", 0, false
