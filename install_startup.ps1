$TargetFile = "f:\job\run_agent.vbs"
$ShortcutFile = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\JobDiscoveryAgent.lnk"
$WScriptShell = New-Object -ComObject WScript.Shell
$Shortcut = $WScriptShell.CreateShortcut($ShortcutFile)
$Shortcut.TargetPath = $TargetFile
$Shortcut.WorkingDirectory = "f:\job"
$Shortcut.Save()
Write-Host "Startup shortcut created successfully at: $ShortcutFile"
