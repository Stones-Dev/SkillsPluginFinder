<#
.SYNOPSIS
  Registra en el Programador de tareas de Windows las dos tareas del flujo semanal de SkillsPluginFinder.

.DESCRIPTION
  Una vez (con tu usuario, sin administrador):
    powershell -NoProfile -File scripts/schedule-windows.ps1

  Tareas que crea (el nombre lleva el prefijo -TaskPrefix, por defecto "SPF"):
    "SPF - evaluar semana (lunes 09:00)"   lunes 09:00  run-weekly.ps1 -Mode first
        git pull --ff-only y claude -p "/evaluar-semana <semana>", que encadena Antigravity, el cruce, la
        publicacion y la revision de hallazgos.
    "SPF - reintento (lunes 12:00)"        lunes 12:00  run-weekly.ps1 -Mode retry
        Solo lanza el flujo si `pnpm spf status` dice que la semana no esta cerrada (la primera paso se quedo a medias).

  Cada ejecucion deja su log en data/logs/ (weekly-<modo>-<fecha>.log y .claude.out.txt/.err.txt).

  Condiciones, pensadas para este equipo:
    - Solo con la sesion iniciada (-LogonType Interactive): el vault esta en Proton Drive, que solo esta montado con
      tu sesion, y claude usa tu inicio de sesion.
    - -StartWhenAvailable: si el equipo estaba apagado o dormido a esa hora, se lanza al volver (la tarea de las 12:00
      hace lo mismo y se salta sola si la semana ya esta cerrada).
    - Limite de 3 horas por ejecucion y sin instancias solapadas.
    - Con -WakeToRun el equipo se despierta para ejecutarlas (por defecto no).

  Permisos del flujo desatendido: .claude/settings.weekly.json (lo pasa run-weekly.ps1 con --settings). Lo que no
  esta en su lista falla en vez de ejecutarse; no se salta ningun permiso.

  Para quitarlas: powershell -NoProfile -File scripts/schedule-windows.ps1 -Unregister
  Para ver que haria sin registrar nada: -WhatIf.

.PARAMETER RepoRoot
  Raiz del repo. Por defecto, la carpeta que contiene scripts/.
.PARAMETER TaskPrefix
  Prefijo del nombre de las tareas. Por defecto SPF.
.PARAMETER Model
  Modelo de claude (--model) para el flujo. Si se omite, el de tu configuracion.
.PARAMETER WakeToRun
  Despierta el equipo para ejecutar las tareas.
.PARAMETER Unregister
  Elimina las dos tareas en vez de registrarlas.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RepoRoot,
  [string]$TaskPrefix = 'SPF',
  [string]$Model,
  [switch]$WakeToRun,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$runner = Join-Path $RepoRoot 'scripts\run-weekly.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw "No existe $runner" }

$tasks = @(
  [pscustomobject]@{ Name = "$TaskPrefix - evaluar semana (lunes 09:00)"; Mode = 'first'; At = '09:00' },
  [pscustomobject]@{ Name = "$TaskPrefix - reintento (lunes 12:00)"; Mode = 'retry'; At = '12:00' }
)

if ($Unregister) {
  foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) {
      if ($PSCmdlet.ShouldProcess($t.Name, 'Unregister-ScheduledTask')) {
        Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
        Write-Host "Eliminada: $($t.Name)"
      }
    } else {
      Write-Host "No existia: $($t.Name)"
    }
  }
  return
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settingsArgs = @{
  StartWhenAvailable         = $true
  AllowStartIfOnBatteries    = $true
  DontStopIfGoingOnBatteries = $true
  ExecutionTimeLimit         = (New-TimeSpan -Hours 3)
  MultipleInstances          = 'IgnoreNew'
}
if ($WakeToRun) { $settingsArgs['WakeToRun'] = $true }
$settings = New-ScheduledTaskSettingsSet @settingsArgs

foreach ($t in $tasks) {
  $argument = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Mode $($t.Mode)"
  if ($Model) { $argument += " -Model `"$Model`"" }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At $t.At
  if ($PSCmdlet.ShouldProcess($t.Name, "Register-ScheduledTask (lunes $($t.At), run-weekly.ps1 -Mode $($t.Mode))")) {
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
      -Description "SkillsPluginFinder: flujo semanal ($($t.Mode)). Ver scripts/run-weekly.ps1." -Force | Out-Null
    Write-Host "Registrada: $($t.Name)  (lunes $($t.At), usuario $user)"
  }
}
Write-Host ''
Write-Host 'Comprueba con: Get-ScheduledTask -TaskName "SPF*" | Get-ScheduledTaskInfo'
Write-Host 'Logs en data/logs/. Recuerda hacer git push tras cada lunes: el flujo desatendido commitea pero no empuja.'
