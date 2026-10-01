<#
.SYNOPSIS
  Registra en el Programador de tareas de Windows las dos tareas del flujo semanal de SkillsPluginFinder.

.DESCRIPTION
  Una vez (con tu usuario, sin administrador):
    powershell -NoProfile -File scripts/schedule-windows.ps1

  Tareas que crea (el nombre lleva el prefijo -TaskPrefix, por defecto "SPF"):
    "SPF - evaluar semana (lunes 09h00)"   lunes 09:00  run-weekly.ps1 -Mode first
        git pull --ff-only y claude -p "/evaluar-semana <semana>", que encadena Antigravity, el cruce, la
        publicacion y la revision de hallazgos.
    "SPF - reintento (lunes 12h00)"        lunes 12:00  run-weekly.ps1 -Mode retry
        Solo lanza el flujo si `pnpm spf status` dice que la semana no esta cerrada (la primera paso se quedo a medias).

  Los nombres escriben la hora como 09h00 y no 09:00 a proposito: un nombre de tarea no puede llevar \ / : * ? " < > |
  y con los dos puntos Register-ScheduledTask falla con "El parametro no es correcto" (HRESULT 0x80070057).

  El script solo dice "Registrada" despues de comprobar con Get-ScheduledTask que la tarea existe, que no esta
  deshabilitada y que su proximo lanzamiento (Get-ScheduledTaskInfo) es el lunes a la hora pedida. Si algo falla, lo
  cuenta por stderr y sale con codigo 1; nunca imprime un exito que no ha comprobado.

  Cada ejecucion deja su log en data/logs/ (weekly-<modo>-<fecha>.log y .claude.out.txt/.err.txt).
  run-weekly.ps1 decide por el ESTADO de la semana ISO de hoy (`pnpm spf status`), no por el dia: si ya esta evaluada sale
  sin hacer nada ("semana <semana> ya evaluada"), y antes del lunes 06:00 UTC (cron de Actions) sin recogida tampoco
  actua. Por eso las dos tareas llevan -StartWhenAvailable: tras un lunes con el equipo apagado, se ejecutan en cuanto
  se pueda (el martes, etc.) y retoman la semana. El reintento de las 12:00 solo actua si la tarea de las 09:00 llego a
  lanzar el flujo de esa semana y esta sigue sin cerrar; y nunca hay dos ejecuciones a la vez (mutex).

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

  Codigos de salida: 0 todo registrado (o eliminado) y comprobado; 1 algo fallo.

.PARAMETER RepoRoot
  Raiz del repo. Por defecto, la carpeta que contiene scripts/.
.PARAMETER TaskPrefix
  Prefijo del nombre de las tareas. Por defecto SPF. No puede llevar \ / : * ? " < > |
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

function Stop-WithError([string]$Message) {
  [Console]::Error.WriteLine("ERROR: $Message")
  exit 1
}

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$runner = Join-Path $RepoRoot 'scripts\run-weekly.ps1'
if (-not (Test-Path -LiteralPath $runner)) { Stop-WithError "No existe $runner" }

# Caracteres que un nombre de tarea no admite. Con ':' Register-ScheduledTask falla con 0x80070057.
$invalidInName = '[\\/:*?"<>|]'
$tasks = @(
  [pscustomobject]@{ Name = "$TaskPrefix - evaluar semana (lunes 09h00)"; Mode = 'first'; At = '09:00' },
  [pscustomobject]@{ Name = "$TaskPrefix - reintento (lunes 12h00)"; Mode = 'retry'; At = '12:00' }
)
foreach ($t in $tasks) {
  if ($t.Name -match $invalidInName) {
    Stop-WithError "El nombre de tarea '$($t.Name)' lleva un caracter no permitido (\ / : * ? `" < > |). Revisa -TaskPrefix."
  }
}

if ($Unregister) {
  $failures = @()
  foreach ($t in $tasks) {
    if (-not (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue)) {
      Write-Host "No existia: $($t.Name)"
      continue
    }
    if ($PSCmdlet.ShouldProcess($t.Name, 'Unregister-ScheduledTask')) {
      try {
        Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction Stop
        if (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue) { throw 'la tarea sigue existiendo tras eliminarla' }
        Write-Host "Eliminada y comprobada: $($t.Name)"
      } catch {
        $failures += "$($t.Name): $($_.Exception.Message)"
      }
    }
  }
  if ($failures.Count -gt 0) { Stop-WithError ("No se pudieron eliminar todas las tareas:`n  " + ($failures -join "`n  ")) }
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

$failures = @()
foreach ($t in $tasks) {
  $argument = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Mode $($t.Mode)"
  if ($Model) { $argument += " -Model `"$Model`"" }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At $t.At
  if (-not $PSCmdlet.ShouldProcess($t.Name, "Register-ScheduledTask (lunes $($t.At), run-weekly.ps1 -Mode $($t.Mode))")) { continue }

  $registered = $false
  try {
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
      -Description "SkillsPluginFinder: flujo semanal ($($t.Mode)). Ver scripts/run-weekly.ps1." -Force -ErrorAction Stop | Out-Null
    $registered = $true

    # Comprobar de verdad antes de decir nada: existe, esta activa y el proximo lanzamiento es el lunes a esa hora.
    $task = Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
    if (-not $task) { throw 'Register-ScheduledTask no dio error, pero Get-ScheduledTask no encuentra la tarea' }
    if ($task.State -eq 'Disabled') { throw 'la tarea quedo deshabilitada' }
    $next = (Get-ScheduledTaskInfo -TaskName $t.Name -ErrorAction Stop).NextRunTime
    if (-not $next -or $next.DayOfWeek -ne 'Monday' -or $next.ToString('HH:mm') -ne $t.At) {
      throw "su proximo lanzamiento no es un lunes a las $($t.At) (NextRunTime = $next)"
    }
    Write-Host "Registrada y comprobada: $($t.Name)  (usuario $user, proximo lanzamiento $($next.ToString('yyyy-MM-dd HH:mm')))"
  } catch {
    $failures += "$($t.Name): $($_.Exception.Message -replace '\s+', ' ')"
    # Si llego a registrarse pero no pasa la comprobacion, no se deja una tarea a medias.
    if ($registered) { Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue }
  }
}

if ($failures.Count -gt 0) {
  Stop-WithError ("No se registraron todas las tareas:`n  " + ($failures -join "`n  "))
}
if ($WhatIfPreference) { Write-Host '(-WhatIf: no se ha registrado nada)'; return }
Write-Host ''
Write-Host 'Comprueba con: Get-ScheduledTask -TaskName "SPF*" | Get-ScheduledTaskInfo'
Write-Host 'Logs en data/logs/. Recuerda hacer git push tras cada lunes: el flujo desatendido commitea pero no empuja.'
