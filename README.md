# SkillsPluginFinder

Sistema semanal que rastrea GitHub en busca de skills, plugins, servidores MCP, agent-skills y librerías útiles para los proyectos de Stones, los puntúa contra una lista de intereses y deja un informe en el vault de Obsidian. El humano decide qué se prueba; el sistema **nunca instala, clona ni ejecuta** nada de lo que encuentra.

Funciona en dos mitades (detalle en `Plan.md` del vault):

- **Recogida** (`spf collect`): determinista, sin IA y sin acceso al vault. Busca en GitHub, filtra por reglas, enriquece lo que entra en el tope y escribe `data/candidates/YYYY-Www.json`. Puede correr en GitHub Actions.
- **Evaluación** (`spf prepare`, `collect-batch`, `publish`): en local, la hace un agente (Claude Code o Antigravity) leyendo `data/batches/<semana>/batch.md`; escribe el informe y las filas de `Catalogo.md` en el vault.

## Requisitos

Node ≥ 22 y pnpm (la versión fijada está en `packageManager`). Después, `pnpm install`.

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
| `collect [--source github-search]` | Mitad nube: recoge, filtra y enriquece. |
| `rate-limit [--min-core N] [--min-search N]` | Consulta los límites de la API de GitHub del token (`GET /rate_limit`, no gasta cuota). Con los mínimos, sale con error si no alcanzan. |
| `prepare --week <semana>` | Genera `data/batches/<semana>/batch.md`. |
| `collect-batch --week <semana>` | Valida el `scoring.json` del evaluador y guarda los scorings. |
| `publish --week <semana> [--force]` | Escribe `Informes/<semana>.md` y añade filas `candidato` a `Catalogo.md`. No sobrescribe un informe con `revisado: true` sin `--force`. |
| `interests sync` | Sincroniza `Intereses.md` (vault) con `interests.yaml` y exporta `Catalogo.md` a `catalog.json`. |

El flujo de evaluación semanal está en `.claude/commands/evaluar-semana.md` (y su copia para Antigravity en `.agent/workflows/`).

## GitHub Actions (`collect.yml`)

El workflow `collect` ejecuta solo la mitad nube: el cron corre los lunes a las 05:00 UTC y también se puede lanzar a mano (*Actions → collect → Run workflow*), con un input opcional `source` (hoy solo `github-search`; vacío recoge todo). Al terminar hace commit de `data/` con el usuario `spf-bot`.

**Estado: escrito y validado con `actionlint`, pero sin ejecutar todavía en GitHub.**

Antes de recoger, un paso ejecuta `pnpm spf rate-limit --min-core 400 --min-search 30` y deja en el log los límites del token (nunca el token). Si no alcanzan, el job falla antes de gastar nada.

### Secrets

| Secret | ¿Obligatorio? | Para qué |
|---|---|---|
| `GITHUB_TOKEN` | No hay que crearlo | Lo aporta Actions. Sirve para hacer el commit de `data/` y, si no existe `SPF_GITHUB_TOKEN`, también para la API. Según la documentación de GitHub tiene 1.000 peticiones por hora y repositorio, que debería bastar (una recogida gasta unas 250 de `core`). |
| `SPF_GITHUB_TOKEN` | Opcional | Un PAT *fine-grained* de solo lectura de repositorios públicos, el mismo tipo que el de `.env`. Si existe, el workflow lo usa para la API en vez del token automático. Créalo si el paso de cuota falla con el automático. |

Para crear `SPF_GITHUB_TOKEN`: *Settings → Secrets and variables → Actions → New repository secret*, con ese nombre exacto y el PAT como valor.

### Primer run

1. Hacer `git push` de `main`.
2. Lanzar el workflow con *Run workflow* y mirar el paso **Check GitHub API quota**: dice qué token usa y los límites de `core` y `search`.
3. Comprobar que el paso **Commit and push changes** sube `data/` sin conflictos. El repo debe estar al día antes de lanzarlo: `data/seen.sqlite` es binario y dos escritores a la vez lo hacen inmergeable.

## Desarrollo

```
pnpm lint        # Biome
pnpm typecheck   # tsc --noEmit en todos los paquetes
pnpm test        # vitest
```

Las reglas del repo están en `AGENTS.md` y `CLAUDE.md`: una tarea solo se da por hecha con la salida del comando que lo prueba; un commit por tarea; sin ficheros dummy; sin etiquetar versiones salvo petición expresa.
