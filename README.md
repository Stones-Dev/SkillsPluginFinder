# SkillsPluginFinder

Sistema semanal que rastrea GitHub en busca de skills, plugins, servidores MCP, agent-skills y librerías útiles para los proyectos de Stones, los puntúa contra una lista de intereses, deja un informe en el vault de Obsidian y revisa los mejores hallazgos. **Nunca instala nada ni ejecuta código de lo que encuentra**: la recogida y la evaluación solo leen metadatos y READMEs, y la revisión hace como mucho un clon superficial en solo lectura (sin hooks, sin submódulos, sin `install`) en `data/review/`, que nunca entra en git ni en los tests. Lo que se adopta con la revisión es una propuesta escrita; integrarla en un proyecto es trabajo de la sesión de ese proyecto (`Constitution.md` §1 del vault).

Funciona en tres tramos (detalle en `Plan.md` del vault):

- **Recogida** (`spf collect`): determinista, sin IA y sin acceso al vault. Busca en GitHub (`github-search`), compara cada semana los README de las listas `awesome-*` (`awesome-list`), sigue los cambios de `anthropics/skills` y del marketplace oficial de plugins (`anthropic-skills`), filtra por reglas, enriquece lo que entra en el tope y escribe `data/candidates/YYYY-Www.json`. Puede correr en GitHub Actions.
- **Evaluación** (`spf prepare`, `collect-batch`, `cross`, `publish`): en local, la hacen **dos agentes** sobre el mismo `data/batches/<semana>/batch.md`: Claude Code (`scoring.json`) y Antigravity por su CLI `agy` (`scoring-antigravity.json`). `spf cross` los cruza (media; disputa si difieren en 3 o más; confianza alta si los dos llegan a 7) y `publish` escribe el informe y las filas de `Catalogo.md` en el vault.
- **Revisión** (`spf review`): por cada hallazgo en `candidato`, inventario automático del clon y veredicto `probado`, `descartado` o `adoptado`. El agente puede adoptar sin confirmación, **salvo** que haya una señal de supply-chain (scripts de instalación, registro propio, MCP remoto, repo de menos de 30 días con un solo mantenedor, privilegios, o una disputa entre los dos evaluadores): entonces queda en `probado` y se avisa en la nota diaria. Lo adoptado va a `03-Conocimiento/` y a `## Mejoras propuestas` de la nota del proyecto afectado.

## Requisitos

Node ≥ 22 y pnpm (la versión fijada está en `packageManager`). Después, `pnpm install`. Para el flujo semanal local (más abajo) también hacen falta Git y las CLI de Claude Code (`claude`) y Antigravity (`agy`), con la sesión iniciada en las dos.

## Configuración (`.env`)

Copia `.env.example` a `.env` y rellena:

| Variable | Qué es |
|---|---|
| `VAULT_PATH` | Carpeta del proyecto dentro del vault (la que contiene `Intereses.md`, `Catalogo.md` e `Informes/`). Solo la usan los comandos de la mitad local. |
| `GITHUB_TOKEN` | PAT *fine-grained* de GitHub de **solo lectura de repositorios públicos**. Es obligatorio para `collect`: sin token GitHub limita a 10 búsquedas por minuto y 60 peticiones por hora, y la recogida necesita más de 100 búsquedas. |

`.env` está en `.gitignore`: no se sube.

## Comandos

Se ejecutan con `pnpm spf <comando>` (compila antes).

| Comando | Qué hace |
|---|---|
| `week` | Imprime la semana ISO de hoy (`YYYY-Www`, Europe/Madrid). |
| `collect [--source github-search\|awesome-list\|anthropic-skills] [--dry-run]` | Mitad nube: recoge, filtra y enriquece; sin `--source`, todas las fuentes. Con `--dry-run` hace el ensayo —colectores, dedupe (`seen.sqlite` en solo lectura), reglas y tope— y cuenta lo que pasaría **sin escribir nada** (ni `data/candidates/`, ni `seen.sqlite`, ni `runs`, ni la caché de `data/cache/`) y sin enriquecer; sí gasta las ~109 búsquedas (≈ 4 min). **Única excepción:** crea las instantáneas de `data/awesome/` y `data/anthropic/` que falten (nunca sobrescribe una existente; ver abajo). Es la forma segura de probar un colector o un cambio de `Intereses.md` antes del lunes. |
| `rate-limit [--min-core N] [--min-search N]` | Consulta los límites de la API de GitHub del token (`GET /rate_limit`, no gasta cuota). Con los mínimos, sale con error si no alcanzan. |
| `prepare --week <semana>` | Genera `data/batches/<semana>/batch.md`. |
| `collect-batch --week <semana> [--agent antigravity] [--reason <texto>]` | Valida el scoring del evaluador y guarda los scorings. Con `--agent antigravity` valida `scoring-antigravity.json` y un fallo **no es fatal**: se anota en `runs` (con `--reason`, la causa del wrapper de `agy`) y la semana sigue solo con Claude Code. |
| `cross --week <semana>` | Cruza las dos evaluaciones y escribe `data/batches/<semana>/cruce.json`. Dice si el cruce cambia el informe. |
| `publish --week <semana> [--force]` | Escribe `Informes/<semana>.md` (con el score cruzado, si hay cruce) y añade filas `candidato` a `Catalogo.md`; las filas `candidato` ya existentes de esa semana se ponen al día con el score y la marca del cruce. No sobrescribe un informe con `revisado: true` sin `--force`. |
| `review --list` | Filas `candidato` de `Catalogo.md` con id, categoría, score, proyecto afectado y URL. |
| `review --prepare <id> \| --week <semana>` | Clon superficial en solo lectura en `data/review/<owner>__<repo>/`, inventario de supply-chain y `review.md` + `review.json`. |
| `review --apply <id> --estado probado\|descartado\|adoptado --nota "…" [--senal <tipo…>]` | Escribe el estado en `Catalogo.md` (edita solo esa línea). `adoptado` se rechaza ante cualquier señal de supply-chain: escribe `probado`, avisa en la nota diaria y sale con código 1. Borra el clon. |
| `status --week <semana>` | Qué pasos del flujo semanal están hechos. Sale con 0 si la semana está cerrada, 1 si quedan pasos y 2 si no hay recogida. |
| `interests sync` | Sincroniza `Intereses.md` (vault) con `interests.yaml` y exporta `Catalogo.md` a `catalog.json`. |

Los flujos de los agentes están en `.claude/commands/` (y su copia para Antigravity en `.agent/workflows/`): `evaluar-semana` (encadena todo lo de abajo), `cruzar-evaluaciones` y `revisar-hallazgos`.

## Flujo semanal automático (local)

Después de que el cron de `collect.yml` deje la recogida del lunes, el equipo de Stones hace el resto sin supervisión con dos tareas del Programador de tareas de Windows:

| Tarea | Cuándo | Qué hace |
|---|---|---|
| `SPF - evaluar semana (lunes 09h00)` | lunes 09:00 | `git pull --ff-only` y `claude -p "/evaluar-semana <semana>"`: evalúa → `agy` evalúa lo mismo (`scripts/agy-eval.ps1`) → cruce → informe → revisión de hallazgos. |
| `SPF - reintento (lunes 12h00)` | lunes 12:00 | Lo mismo, pero **solo** si `pnpm spf status` dice que la semana no está cerrada (la primera pasada se quedó a medias). |

- **Registrarlas, una vez:** `powershell -NoProfile -File scripts/schedule-windows.ps1` (con `-WhatIf` enseña qué haría sin registrar nada; con `-Unregister` las quita; `-WakeToRun` despierta el equipo). El script solo dice «Registrada y comprobada» tras verificar con `Get-ScheduledTask` que la tarea existe y que su próximo lanzamiento es un lunes a la hora pedida; si algo falla, sale con código 1. Comprobación posterior: `Get-ScheduledTask -TaskName "SPF*" | Get-ScheduledTaskInfo`. Los nombres escriben la hora como `09h00` a propósito: un nombre de tarea no admite `: \ / * ? " < > |` y con `09:00` el Programador rechaza el registro (`0x80070057`, «El parámetro no es correcto»). Solo se ejecutan con la sesión iniciada: el vault está en Proton Drive y `claude` usa tu inicio de sesión. `-StartWhenAvailable` las lanza al volver si el equipo estaba apagado.
- **Guarda por semana, no por día:** `scripts/run-weekly.ps1` mira el estado de la semana ISO de hoy con `pnpm spf status --week <semana> --json`, sea el día que sea. Si la semana ya está completa, sale con 0 («semana 2026-W41 ya evaluada») y lanzar una tarea a mano no hace nada. Si no, lanza `/evaluar-semana`, o solo `/revisar-hallazgos --week` cuando la evaluación y la publicación están hechas y solo quedan hallazgos por revisar (así no se reevalúa una semana ya evaluada). Con `-StartWhenAvailable`, un lunes con el equipo apagado se recupera solo en cuanto vuelvas (martes, etc.). Antes del lunes 06:00 UTC de la semana (el cron de Actions es a las 05:00) y sin `data/candidates/<semana>.json`, sale con 0 («aún no hay recogida») y no toca la semana en curso.
- **El reintento de las 12:00** solo actúa si la tarea de las 09:00 llegó a lanzar el flujo de esa semana (lo busca en sus logs) y la semana sigue sin cerrar; y nunca hay dos ejecuciones a la vez (mutex `Local\SPF-weekly-flow`: con `-StartWhenAvailable` las dos tareas se disparan juntas al volver el equipo).
- **Permisos:** `.claude/settings.weekly.json` (lo pasa `scripts/run-weekly.ps1` con `--settings`) es una allowlist concreta de órdenes `pnpm spf`, git de lectura y commit, `agy-eval.ps1`, lectura y escritura de ficheros y `WebFetch` de unos pocos dominios de lectura; deniega `git push`, `git tag`, `rm`, `curl`, `npm`/`npx` y `.env`. Lo que no esté en la lista falla en vez de ejecutarse; **no se usa `--dangerously-skip-permissions`**. Afecta solo a este flujo, no a tus sesiones interactivas en el repo.
- **Antigravity (`agy`):** `scripts/agy-eval.ps1` lo lanza con `--mode accept-edits --sandbox` (escribe ficheros sin pedir permiso, pero aborta si intenta usar la terminal), 40 minutos como máximo, y compara el estado del repo, `.env` y las notas `Catalogo.md`/`Intereses.md` antes y después: si cambia algo más que su fichero de salida, sale con 5 sin revertir y el flujo se detiene para que lo mires. Si falla por cualquier otro motivo, la semana sigue con la evaluación de Claude Code.
- **Logs:** `data/logs/weekly-<modo>-<fecha>.log` y `.claude.out.txt`/`.err.txt` (ignorados por git).
- **El flujo commitea pero no hace push.** Haz `git push` tras cada lunes: el commit local choca con el del bot de Actions de la semana siguiente (`data/seen.sqlite` es binario y no se puede fusionar). Si `git pull --ff-only` no es fast-forward, el flujo aborta (código 10) y lo deja en el log.
- **A mano:** `claude -p "/evaluar-semana"` (o `/evaluar-semana` dentro de una sesión). Para repetir solo el cruce de una semana: `/cruzar-evaluaciones <semana>`; solo la revisión: `/revisar-hallazgos`.

## Listas `awesome-*` (`awesome-list`)

Las listas que sigue el colector van en el bloque opcional `awesome_listas` de `Intereses.md` (`owner/repo` de la lista → categoría de sus novedades; la categoría tiene que existir). Cada semana, por lista:

1. `GET /repos/{owner}/{repo}/readme` en formato `raw` con `If-None-Match` (la ETag de la semana anterior). Un `304` cuesta **0** peticiones; una respuesta `200` cuesta 1 (medido con las cabeceras `x-ratelimit-*`).
2. Se extraen los enlaces `github.com/<owner>/<repo>` del README (nada más se lee de él: es contenido no confiable) y se comparan con la instantánea `data/awesome/<owner>-<repo>.json`.
3. Los enlaces nuevos se resuelven con `GET /repos/{owner}/{repo}` (como mucho 100 por lista y semana; el resto vuelve la siguiente) y entran por el mismo normalize, dedupe, reglas y tope que lo que sale de la búsqueda. Un repo que sale de las dos fuentes es un solo candidato con los dos orígenes.

- **Primera pasada** (sin instantánea): solo se anota qué enlaces hay; no hay candidatos.
- **Nada se pierde:** la instantánea se escribe al final de la recogida, así que un fallo a mitad deja las novedades para la siguiente. Los candidatos que el tope `enrich_max` difiere, los enlaces por encima de los 100 y los que fallan por un error transitorio no entran en la instantánea (y su ETag se anula) y vuelven la semana siguiente; un repo que ya no existe (404/410/451) se da por visto.
- **`--dry-run` crea la instantánea que falta y nunca sobrescribe una existente**: si lo hiciera, el ensayo se comería las novedades que debe ver la recogida real. Es la única escritura que hace.
- Una instantánea corrupta, o de otra lista con el mismo nombre de fichero, no se sobrescribe: la lista da error y las demás siguen.
- Las instantáneas van al repo (`data/awesome/`): sin ellas, la recogida de Actions sería siempre una primera pasada.

## Skills y plugins oficiales de Anthropic (`anthropic-skills`)

Sigue dos repos, sin releases ni tags (verificado): `anthropics/skills` y el marketplace oficial de plugins de Claude Code, `anthropics/claude-plugins-official`. Por repo y semana:

1. `GET /repos/{owner}/{repo}/commits` con `If-None-Match`: un `304` (HEAD no se movió) cuesta **0** peticiones y no se pide nada más.
2. Si cambió, el estado en HEAD: en `anthropics/skills` el listado de `skills/` (cada directorio trae el sha de su árbol); en el marketplace su `.claude-plugin/marketplace.json`, comparado por una huella de cada entrada **sin `source.sha` ni `source.ref`** (los pines se mueven en bloque y serían ruido).
3. Se compara con la instantánea `data/anthropic/<owner>-<repo>.json` y el resultado son dos cosas:
   - **Changelog oficial** (skills y plugins nuevos, actualizados y eliminados, más los commits de `anthropics/skills` desde la última vez): va al fichero de la semana (`oficiales`) y al informe, en «Novedades oficiales de Anthropic». Es informativo: no puntúa ni entra en el catálogo. Por eso `anthropics/skills` sigue en `excluir`.
   - **Candidatos**: los plugins **nuevos** del marketplace que viven en su propio repo de GitHub (262 de 315) se resuelven con `GET /repos/{owner}/{repo}` y pasan por el mismo normalize, dedupe, reglas y tope. Su categoría es `anthropic_categoria` de `Intereses.md`; sin ella no hay candidatos, solo changelog. Como máximo 50 por recogida; el resto vuelve la semana siguiente.

Igual que `awesome-list`: primera pasada = solo instantánea; las instantáneas se escriben al final de la recogida; lo que difiere `enrich_max` o falla de forma transitoria no se da por visto; `--dry-run` crea la instantánea que falta y nunca sobrescribe una existente.

## GitHub Actions (`collect.yml`)

El workflow `collect` ejecuta solo la mitad nube: el cron corre los lunes a las 05:00 UTC y también se puede lanzar a mano (*Actions → collect → Run workflow*), con un input opcional `source` (`github-search`, `awesome-list` o `anthropic-skills`; vacío recoge todo). Al terminar hace commit de `data/` con el usuario `spf-bot`.

**Estado: escrito y validado con `actionlint`, pero sin ejecutar todavía en GitHub.**

Antes de recoger, un paso ejecuta `pnpm spf rate-limit --min-core 600 --min-search 30` y deja en el log los límites del token (nunca el token). Si no alcanzan, el job falla antes de gastar nada.

### Secrets

| Secret | ¿Obligatorio? | Para qué |
|---|---|---|
| `GITHUB_TOKEN` | No hay que crearlo | Lo aporta Actions. Sirve para hacer el commit de `data/` y, si no existe `SPF_GITHUB_TOKEN`, también para la API. Según la documentación de GitHub tiene 1.000 peticiones por hora y repositorio, que debería bastar (una recogida gasta unas 250 de `core`). |
| `SPF_GITHUB_TOKEN` | Opcional | Un PAT *fine-grained* de solo lectura de repositorios públicos, el mismo tipo que el de `.env`. Si existe, el workflow lo usa para la API en vez del token automático. Créalo si el paso de cuota falla con el automático. |

Para crear `SPF_GITHUB_TOKEN`: *Settings → Secrets and variables → Actions → New repository secret*, con ese nombre exacto y el PAT como valor.

### Primer run

1. Hacer `git push` de `main`. Desde ese momento el cron queda activo.
2. **No lanzarlo antes de que empiece la semana que quieres recoger.** La recogida escribe en `data/candidates/<semana actual>.json` y la semana se calcula en hora de Madrid: hasta la medianoche del domingo 4 de octubre sigue siendo la 2026-W40, que ya está evaluada y publicada, y un run manual añadiría candidatos sin evaluar a ese fichero. El cron del lunes 5 (05:00 UTC, las 07:00 en Madrid) ya cae en la 2026-W41 y es el primer run que conviene mirar.
3. Con el run en marcha (cron o *Run workflow*), mirar el paso **Check GitHub API quota**: dice qué token usa y los límites de `core` y `search`. Si falla por falta de cuota, crear `SPF_GITHUB_TOKEN` y volver a lanzarlo.
4. Comprobar que el paso **Commit and push changes** sube `data/` sin conflictos. El repo debe estar al día antes de lanzarlo: `data/seen.sqlite` es binario y dos escritores a la vez lo hacen inmergeable.

## Desarrollo

```
pnpm lint        # Biome
pnpm typecheck   # tsc --noEmit en todos los paquetes
pnpm test        # vitest
```

Las reglas del repo están en `AGENTS.md` y `CLAUDE.md`: una tarea solo se da por hecha con la salida del comando que lo prueba; un commit por tarea; sin ficheros dummy; sin etiquetar versiones salvo petición expresa.
