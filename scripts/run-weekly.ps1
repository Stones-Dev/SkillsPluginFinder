<#
.SYNOPSIS
  Ejecuta el flujo semanal de SkillsPluginFinder sin supervision: claude -p "/evaluar-semana <semana>" (que encadena
  Antigravity, el cruce, la publicacion y la revision de hallazgos) con la allowlist de .claude/settings.weekly.json.

.DESCRIPTION
  Lo lanzan las dos tareas de scripts/schedule-windows.ps1:
    -Mode first   lunes 09:00. Hace git pull --ff-only y lanza el flujo.
    -Mode retry   lunes 12:00. Solo lanza el flujo si `pnpm spf status` dice que la semana no esta cerrada.

  Siempre, antes de lanzar nada, mira `pnpm spf status --week <semana>`:
    0 cerrada        -> no hace nada
    2 sin recogida   -> no hay nada que evaluar (la nube aun no ha recogido): first sale con 12, retry con 0
    1 sin cerrar     -> lanza el flujo

  **Solo se lanza los lunes** (hora de Madrid): otro dia sale con 0 sin hacer nada y lo deja en el log. Con -AllowAnyDay se
  salta esa guarda (lanzamiento manual a proposito).

  No hace git push (lo hace Stones) y git pull es --ff-only: si no es fast-forward aborta con 10, porque
  data/seen.sqlite es binario y dos escritores a la vez lo hacen inmergeable.

  Cada ejecucion deja en data/logs/ (ignorado por git): weekly-<modo>-<fecha>.log (lo que hizo este script),
  weekly-<modo>-<fecha>.claude.out.txt y .err.txt (lo que dijo claude).

  Codigos de salida:
    0 ok o nada que hacer     3 claude no termino y se mato     4 claude salio con error
    10 git pull no fue fast-forward   11 no se encuentra el vault (VAULT_PATH)   12 sin recogida (solo first)
    13 no se encuentra claude   14 pnpm fallo al dar la semana

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
.PARAMETER AllowAnyDay
  Se salta la guarda del lunes (lanzamiento manual a proposito).
.PARAMETER Now
  Fecha y hora que se toman por "ahora" para la guarda del lunes (pruebas). Por defecto, la de Madrid.

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
  [switch]$AllowAnyDay,
  [datetime]$Now
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

Write-Log "modo $Mode, repo $RepoRoot"

# --- guarda: el flujo semanal solo se lanza los lunes (hora de Madrid, la de `spf week`) ---------------------------------
# Antes de tocar nada. Sin ella, lanzar la tarea a mano otro dia (Start-ScheduledTask) relanzaria /evaluar-semana sobre una
# semana ya evaluada y a medias de revisar. Para lanzarlo a proposito un martes, p. ej. tras un lunes con el equipo apagado
# mas de lo que cubre -StartWhenAvailable: -AllowAnyDay.
if ($PSBoundParameters.ContainsKey('Now')) { $madrid = $Now }
else {
  try { $madrid = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'Romance Standard Time') }
  catch { $madrid = Get-Date }
}
if (-not $AllowAnyDay -and $madrid.DayOfWeek -ne 'Monday') {
  Finish 0 "hoy no es lunes ($($madrid.DayOfWeek) $($madrid.ToString('yyyy-MM-dd')), hora de Madrid): no hago nada. Para lanzarlo a mano otro dia, -AllowAnyDay"
}

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

# --- git pull --ff-only -------------------------------------------------------------------------------------------------
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

# --- estado: hay algo que hacer? ---------------------------------------------------------------------------------------
$status = Invoke-Native $Pnpm (@($PnpmPrefixArgs) + @('-s', 'spf', 'status', '--week', $Week))
Write-Log "spf status -> $($status.Code)`n$($status.Output)"
if ($status.Code -eq 0) { Finish 0 "la semana $Week ya esta cerrada: nada que hacer" }
if ($status.Code -eq 2) {
  if ($Mode -eq 'first') { Finish 12 "no hay recogida de $Week (data/candidates/$Week.json): nada que evaluar todavia; el reintento volvera a mirar" }
  Finish 0 "sigue sin haber recogida de ${Week}: nada que reintentar"
}
if ($status.Code -ne 1) { Finish 14 "spf status salio con $($status.Code): $($status.Output)" }

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
  '-p', "/evaluar-semana $Week",
  '--settings', $settings,
  '--add-dir', $vaultRoot,
  '--no-session-persistence',
  '--output-format', 'text'
)
if ($Model) { $claudeArgs += @('--model', $Model) }
$argumentString = ($claudeArgs | ForEach-Object { ConvertTo-CommandLineArg ([string]$_) }) -join ' '

$outFile = Join-Path $logDir "weekly-$Mode-$stamp.claude.out.txt"
$errFile = Join-Path $logDir "weekly-$Mode-$stamp.claude.err.txt"
Write-Log "lanzo: $($resolved.Source) -p '/evaluar-semana $Week' (limite $TimeoutSeconds s)"
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
Finish 0 "flujo lanzado; estado final de la semana: codigo $($after.Code) (0 cerrada, 1 con pasos pendientes)"
