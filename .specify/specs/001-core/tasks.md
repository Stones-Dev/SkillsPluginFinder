# Tasks — SkillsPluginFinder

Lista de tareas generadas a partir de [[Spec]] y [[Plan]], organizadas por sub-fases del Roadmap.

Estado real a 2026-10-01. `[x]` hecho y comprobado con la salida de un comando; `[/]` escrito o parcial; `[ ]` pendiente.

## [F0] Cierre del SDD
- [x] T001: Responder Clarify y ajustar Plan.
- [x] T002: Crear repo privado, inicializar git y specify, e importar artefactos (Constitution, Spec, Plan).
- [x] T003: Escribir ADR-001 Repo del proyecto como bus de datos.
- [x] T004: Escribir ADR-002 Evaluación por agente local sin SDK de LLM.
- [x] T005: Escribir ADR-003 SQLite + Drizzle en F1, PostgreSQL en F5.
- [x] T006: Realizar commit inicial de bootstrap e importación.

## [F1] Vertical slice local
- [x] T101: Configurar monorepo pnpm, TS estricto, Biome, Vitest y CLI spf.
- [x] T102: Implementar módulo config (esquema zod de intereses) y vault (lectura/escritura y interests:sync).
- [x] T103: Implementar colector github-search con throttling y caché.
- [x] T104: Implementar módulos normalize y dedupe con SQLite (Drizzle).
- [x] T105: Implementar módulo filter (reglas + exclusiones).
- [x] T106: Implementar comando spf collect completo.
- [x] T107: Implementar módulo batch (prepare-batch y collect-batch).
- [x] T108: Implementar módulo publish (escritura de informes y catálogo en vault).
- [x] T109: Crear workflows .agent/workflows/evaluar-semana.md y .claude/commands/evaluar-semana.md.
- [x] T110: Ejecución real end-to-end y primer informe (semana 2026-W40, commit 5cda3d1; informe verificado por Stones en Obsidian).

## [F2] Mitad nube en GitHub Actions
- [/] T201: Crear workflow collect.yml para GitHub Actions (escrito, sin ejecutar en Actions).
- [/] T202: Crear Dockerfile multi-stage (escrito, sin construir).

## [F3] Fuentes ola 1 + enrich
- [ ] T301: Añadir fuentes: awesome-list, anthropic-skills, mcp-registry, npm, hn.
- [ ] T302: Implementar enriquecimiento de datos (contributors, releases, licencias, riesgos). Ya existe desde F1 el de GitHub: README, contribuidores y scripts de instalación; faltan releases y permisos.
- [ ] T303: Mejorar informes con secciones de riesgos y errores. El informe de F1 ya trae las señales de riesgo por hallazgo y los errores por fuente.
- [ ] T304: Adaptar spf prepare para fusionar múltiples semanas.

## [F4] Calibración
- [ ] T401: Implementar cambio de estados y revisión mensual de intereses.
- [ ] T402: Añadir fuentes ola 2 (crates, nuget, reddit, blogs, github-releases).
- [ ] T403: Tag v1.0.0 (solo si Stones lo pide expresamente).

## [F5] VPS + dominio
- [ ] T501: Configurar VPS, dominio y DNS.
- [ ] T502: Crear docker-compose.yml (worker, db, caddy).
- [ ] T503: Migrar Drizzle de SQLite a PostgreSQL.
- [ ] T504: Configurar acceso (Cloudflare Access o passkey).

## [F6] Web app
- [ ] T601: Inicializar app Next.js 15 y dependencias de UI.
- [ ] T602: Implementar dashboard de ejecuciones y vista de candidatos.
- [ ] T603: Implementar editor de interests.yaml y sincronización.
- [ ] T604: Tag v2.0.0 (solo si Stones lo pide expresamente).
