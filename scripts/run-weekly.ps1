<#
.SYNOPSIS
  Ejecuta el flujo semanal de SkillsPluginFinder sin supervision: claude -p "/evaluar-semana <semana>" (que encadena
  Antigravity, el cruce, la publicacion y la revision de hallazgos) con la allowlist de .claude/settings.weekly.json.

.DESCRIPTION
  Lo lanzan las dos tareas de scripts/schedule-windows.ps1, los lunes a las 09:00 (first) y a las 12:00 (retry), las dos
  con StartWhenAvailable: si el equipo estaba apagado o dormido a esa hora, se lanzan al volver.

  La guarda es POR SEMANA ISO, no por dia. Lo que decide si se lanza algo es el estado de la semana de hoy
  (`pnpm spf week`), sea el dia que sea. En este orden:

    1. Otra ejecucion en curso (mutex local): no hace nada. Con StartWhenAvailable, tras un equipo apagado las dos tareas se
       disparan a la vez; solo una entra.
    2. Antes del cron de Actions: si es antes del lunes 06:00 UTC de esa semana ISO y no existe
       data/candidates/<semana>.json, sale con 0 ("aun no hay recogida"): no pisa la semana en curso.
    3. `pnpm spf status --week <semana> --json`:
         0 completa            -> sale con 0 ("semana <semana> ya evaluada")
         2 sin recogida        -> no hay nada que evaluar: first sale con 12, retry con 0
         1 sin completar       -> lanza el flujo (abajo)
    4. Solo retry: ademas exige que first haya LANZADO el flujo de esa semana (lo busca en los logs de first). Es el
       "first dejo la semana sin cerrar": si first nunca llego a lanzar nada (p. ej. git pull no fue fast-forward), el
       reintento no lo reintenta a ciegas.

  Que se lanza cuando la semana esta sin completar:
    - falta cualquier paso de la evaluacion (recogida ya hecha, evaluacion de Claude Code, la de Antigravity, cruce,
      publicacion): claude -p "/evaluar-semana <semana>" (que retoma por el primer paso pendiente).
    - la evaluacion y la publicacion estan hechas y solo faltan hallazgos por revisar: claude -p
      "/revisar-hallazgos --week <semana>". Asi no se reevalua una semana ya evaluada solo porque quede algo por revisar.

  No hace git push (lo hace Stones) y git pull es --ff-only: si no es fast-forward aborta con 10, porque
  data/seen.sqlite es binario y dos escritores a la vez lo hacen inmergeable.

  Cada ejecucion deja en data/logs/ (ignorado por git): weekly-<modo>-<fecha>.log (lo que hizo este script),
  weekly-<modo>-<fecha>.claude.out.txt y .err.txt (lo que dijo claude).

  Codigos de salida:
    0 ok o nada que hacer     3 claude no termino y se mato     4 claude salio con error
    10 git pull no fue fast-forward   11 no se encuentra el vault (VAULT_PATH)   12 sin recogida (solo first)
    13 no se encuentra claude   14 pnpm fallo (semana o estado)

.PARAMETER Mode
  first | retry.
.PARAMETER Week
  Semana ISO (YYYY-Www). Por defecto la de hoy (pnpm spf week).
.PARAMETER RepoRoot
  Raiz del repo. Por defecto, la carpeta que contiene scripts/.
.PARAMETER Claude
  Ruta de claude. Por defecto $env:CLAUDE_PATH, luego `claude` del PATH y por ultimo ~\.local\bin\claude.exe.
.PARAMETER ClaudePrefixArgs
  Argumentos antes de los de claude: solo para probar el script con otro ejecutable.
.PARAMETER Pnpm
  Ejecutable de pnpm. Por defecto `pnpm`.
.PARAMETER PnpmPrefixArgs
  Argumentos antes de los de pnpm: solo para probar el script con otro ejecutable.
.PARAMETER Model
  Modelo de claude (--model). Si se omite, el de la configuracion del usuario.
.PARAMETER TimeoutSeconds
  Tiempo maximo de claude antes de matarlo. Por defecto 9000 (150 minutos).
.PARAMETER SkipPull
  No hace git pull (pruebas).
.PARAMETER NowUtc
  Fecha y hora que se toman por "ahora" para la guarda previa al cron (pruebas). Por defecto, la actual.
.PARAMETER LockName
  Nombre del mutex que impide dos ejecuciones a la vez. Por defecto Local\SPF-weekly-flow (pruebas: otro nombre).

.EXAMPLE
  powershell -NoProfile -File scripts/run-weekly.ps1 -Mode first
#>
[CmdletBinding()]
param(
  [ValidateSet('first', 'retry')][string]$Mode = 'first',
  [string]$Week,
  [string]$RepoRoot,
  [string]$Claude,
  [string[]]$ClaudePrefixArgs = @(),
  [string]$Pnpm = 'pnpm',
  [string[]]$PnpmPrefixArgs = @(),
  [string]$Model,
  [int]$TimeoutSeconds = 9000,
  [switch]$SkipPull,
  [datetime]$NowUtc,
  [string]$LockName = 'Local\SPF-weekly-flow'
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
Set-Location -LiteralPath $RepoRoot

$logDir = Join-Path $RepoRoot 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "weekly-$Mode-$stamp.log"

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format 'HH:mm:ss') $Message"
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Finish([int]$Code, [string]$Message) {
  Write-Log "RESULTADO ($Code): $Message"
  exit $Code
}

# Quoting de un argumento para la linea de comandos de Windows (igual que scripts/agy-eval.ps1).
function ConvertTo-CommandLineArg([string]$Value) {
  if ($Value -eq '') { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

# Ejecuta un programa nativo y devuelve codigo y salida. Sin tuberias que se traguen la salida ni NativeCommandError.
function Invoke-Native([string]$File, [string[]]$ArgList) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & $File @ArgList 2>&1 | ForEach-Object { "$_" } }
  finally { $ErrorActionPreference = $previous }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Output = (@($output) -join "`n").Trim() }
}

# Lunes (00:00 UTC) de una semana ISO YYYY-Www: el lunes de la semana 1 es el anterior o igual al 4 de enero.
function Get-IsoWeekMondayUtc([string]$IsoWeek) {
  $year = [int]$IsoWeek.Substring(0, 4)
  $number = [int]$IsoWeek.Substring(6, 2)
  $jan4 = [datetime]::new($year, 1, 4, 0, 0, 0, [DateTimeKind]::Utc)
  $mondayOfWeek1 = $jan4.AddDays(-((([int]$jan4.DayOfWeek) + 6) % 7))
  return $mondayOfWeek1.AddDays(7 * ($number - 1))
}

Write-Log "modo $Mode, repo $RepoRoot"

# --- 1. una sola ejecucion a la vez --------------------------------------------------------------------------------------
$mutex = New-Object System.Threading.Mutex($false, $LockName)
if (-not $mutex.WaitOne(0)) {
  Finish 0 'otra ejecucion del flujo semanal esta en curso: no hago nada'
}
# El mutex se libera al terminar el proceso (el script sale siempre con exit).

# --- el vault (hace falta su raiz para --add-dir) -----------------------------------------------------------------------
$vaultPath = $env:VAULT_PATH
$envFile = Join-Path $RepoRoot '.env'
if (-not $vaultPath -and (Test-Path -LiteralPath $envFile)) {
  $m = Select-String -LiteralPath $envFile -Pattern '^\s*VAULT_PATH\s*=\s*(.+?)\s*$' | Select-Object -First 1
  if ($m) { $vaultPath = $m.Matches[0].Groups[1].Value.Trim('"', "'") }
}
if (-not $vaultPath -or -not (Test-Path -LiteralPath $vaultPath)) {
  Finish 11 "no encuentro el vault: VAULT_PATH ('$vaultPath') no existe (Proton Drive sin montar o .env sin rellenar)"
}
$vaultRoot = Split-Path -Parent (Split-Path -Parent ((Resolve-Path -LiteralPath $vaultPath).Path.TrimEnd('\', '/')))
if (-not (Test-Path -LiteralPath (Join-Path $vaultRoot '02-Proyectos'))) {
  Finish 11 "la raiz del vault ($vaultRoot) no tiene 02-Proyectos: VAULT_PATH debe apuntar a 02-Proyectos/SkillsPluginFinder"
}

# --- git pull --ff-only (trae lo que haya recogido el bot de Actions) ---------------------------------------------------
if (-not $SkipPull) {
  $pull = Invoke-Native 'git' @('pull', '--ff-only')
  Write-Log "git pull --ff-only -> $($pull.Code): $($pull.Output)"
  if ($pull.Code -ne 0) {
    Finish 10 'git pull --ff-only no fue fast-forward (o fallo): no se evalua sobre un repo desfasado; resuelvelo a mano (data/seen.sqlite es binario)'
  }
}

# --- la semana ----------------------------------------------------------------------------------------------------------
if (-not $Week) {
  $w = Invoke-Native $Pnpm (@($PnpmPrefixArgs) + @('-s', 'spf', 'week'))
  if ($w.Code -ne 0 -or $w.Output -notmatch '(\d{4}-W\d{2})\s*$') { Finish 14 "pnpm spf week fallo ($($w.Code)): $($w.Output)" }
  $Week = $Matches[1]
}
if ($Week -notmatch '^\d{4}-W\d{2}$') { Finish 14 "semana no valida: '$Week'" }
Write-Log "semana $Week"

# --- 2. antes del cron de Actions: no pisar la semana en curso ----------------------------------------------------------
$candidatesFile = Join-Path $RepoRoot "data\candidates\$Week.json"
$cronUtc = (Get-IsoWeekMondayUtc $Week).AddHours(6)
$nowUtc = if ($PSBoundParameters.ContainsKey('NowUtc')) { $NowUtc.ToUniversalTime() } else { [DateTime]::UtcNow }
if (($nowUtc -lt $cronUtc) -and -not (Test-Path -LiteralPath $candidatesFile)) {
  Finish 0 "aun no hay recogida de ${Week}: es antes del lunes 06:00 UTC ($($cronUtc.ToString('yyyy-MM-dd HH:mm')) UTC) de esa semana y no existe data/candidates/$Week.json; el cron de Actions todavia no ha corrido"
}

# --- 3. estado de la semana ---------------------------------------------------------------------------------------------
$status = Invoke-Native $Pnpm (@($PnpmPrefixArgs) + @('-s', 'spf', 'status', '--week', $Week, '--json'))
Write-Log "spf status --json -> $($status.Code)`n$($status.Output)"
if ($status.Code -eq 0) { Finish 0 "semana $Week ya evaluada: nada que hacer" }
if ($status.Code -eq 2) {
  if ($Mode -eq 'first') { Finish 12 "no hay recogida de $Week (data/candidates/$Week.json): nada que evaluar todavia; el reintento volvera a mirar" }
  Finish 0 "sigue sin haber recogida de ${Week}: nada que reintentar"
}
if ($status.Code -ne 1) { Finish 14 "spf status salio con $($status.Code): $($status.Output)" }

# Pasos hechos, por su id estable (los nombres llevan tildes y este script es ASCII).
$done = @{}
try {
  $json = [regex]::Match($status.Output, '\{[\s\S]*\}').Value | ConvertFrom-Json
  foreach ($s in $json.steps) { $done[[string]$s.id] = [bool]$s.done }
} catch {
  Write-Log "no pude leer el JSON de spf status ($($_.Exception.Message)): se lanza el flujo completo"
}
$evaluationDone = $true
foreach ($id in 'recogida', 'claude', 'antigravity', 'cruce', 'publicacion') {
  if (-not $done[$id]) { $evaluationDone = $false }
}
$workflow = if ($evaluationDone) { "/revisar-hallazgos --week $Week" } else { "/evaluar-semana $Week" }

# --- 4. el reintento solo reintenta lo que first dejo a medias ----------------------------------------------------------
if ($Mode -eq 'retry') {
  $firstLaunched = $false
  foreach ($f in @(Get-ChildItem -LiteralPath $logDir -Filter 'weekly-first-*.log' -File -ErrorAction SilentlyContinue)) {
    $text = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($text -and $text.Contains("semana $Week") -and $text.Contains('lanzo:')) { $firstLaunched = $true; break }
  }
  if (-not $firstLaunched) {
    Finish 0 "first no llego a lanzar el flujo de ${Week} (no hay un log de first con 'lanzo:'): no hay nada que reintentar"
  }
}

# --- claude -------------------------------------------------------------------------------------------------------------
if (-not $Claude) { $Claude = $env:CLAUDE_PATH }
if (-not $Claude) {
  $found = Get-Command claude -ErrorAction SilentlyContinue
  if ($found) { $Claude = $found.Source }
}
if (-not $Claude -and $env:USERPROFILE) {
  $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $candidate) { $Claude = $candidate }
}
$resolved = if ($Claude) { Get-Command $Claude -ErrorAction SilentlyContinue } else { $null }
if (-not $resolved) { Finish 13 'no encuentro claude: pasa -Claude <ruta>, define CLAUDE_PATH o ponlo en el PATH' }

$settings = Join-Path $RepoRoot '.claude\settings.weekly.json'
$claudeArgs = @($ClaudePrefixArgs) + @(
  '-p', $workflow,
  '--settings', $settings,
  '--add-dir', $vaultRoot,
  '--no-session-persistence',
  '--output-format', 'text'
)
if ($Model) { $claudeArgs += @('--model', $Model) }
$argumentString = ($claudeArgs | ForEach-Object { ConvertTo-CommandLineArg ([string]$_) }) -join ' '

$outFile = Join-Path $logDir "weekly-$Mode-$stamp.claude.out.txt"
$errFile = Join-Path $logDir "weekly-$Mode-$stamp.claude.err.txt"
Write-Log "lanzo: $($resolved.Source) -p '$workflow' (limite $TimeoutSeconds s)"
Write-Log "salida de claude: $outFile"
$process = Start-Process -FilePath $resolved.Source -ArgumentList $argumentString -WorkingDirectory $RepoRoot `
  -RedirectStandardOutput $outFile -RedirectStandardError $errFile -NoNewWindow -PassThru
$null = $process.Handle # sin esto, ExitCode puede quedar vacio tras WaitForExit

if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
  & taskkill /PID $process.Id /T /F | Out-Null
  $after = Invoke-Native $Pnpm (@($PnpmPrefixArgs) + @('-s', 'spf', 'status', '--week', $Week))
  Write-Log "spf status tras matar claude -> $($after.Code)`n$($after.Output)"
  Finish 3 "claude no termino en $TimeoutSeconds s: proceso matado"
}
$claudeCode = $process.ExitCode

$after = Invoke-Native $Pnpm (@($PnpmPrefixArgs) + @('-s', 'spf', 'status', '--week', $Week))
Write-Log "spf status final -> $($after.Code)`n$($after.Output)"
if ($claudeCode -ne 0) { Finish 4 "claude salio con codigo $claudeCode (mira $errFile)" }
Finish 0 "flujo lanzado ($workflow); estado final de la semana: codigo $($after.Code) (0 completa, 1 con pasos pendientes)"
