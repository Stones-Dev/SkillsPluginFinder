# Tasks — SkillsPluginFinder

Lista de tareas generadas a partir de [[Spec]] y [[Plan]], organizadas por sub-fases del Roadmap.

## [F0] Cierre del SDD
- [x] T001: Responder Clarify y ajustar Plan.
- [x] T002: Crear repo privado, inicializar git y specify, e importar artefactos (Constitution, Spec, Plan).
- [ ] T003: Escribir ADR-001 Repo del proyecto como bus de datos.
- [ ] T004: Escribir ADR-002 Evaluación por agente local sin SDK de LLM.
- [ ] T005: Escribir ADR-003 SQLite + Drizzle en F1, PostgreSQL en F5.
- [ ] T006: Realizar commit inicial de bootstrap e importación.

## [F1] Vertical slice local
- [ ] T101: Configurar monorepo pnpm, TS estricto, Biome, Vitest y CLI spf.
- [ ] T102: Implementar módulo config (esquema zod de intereses) y ault (lectura/escritura y interests:sync).
- [ ] T103: Implementar colector github-search con throttling y caché.
- [ ] T104: Implementar módulos 
ormalize y dedupe con SQLite (Drizzle).
- [ ] T105: Implementar módulo ilter (reglas + exclusiones).
- [ ] T106: Implementar comando spf collect completo.
- [ ] T107: Implementar módulo atch (prepare-batch y collect-batch).
- [ ] T108: Implementar módulo publish (escritura de informes y catálogo en vault).
- [ ] T109: Crear workflows .agent/workflows/evaluar-semana.md y .claude/commands/evaluar-semana.md.
- [ ] T110: Ejecución real end-to-end y primer informe.

## [F2] Mitad nube en GitHub Actions
- [ ] T201: Crear workflow collect.yml para GitHub Actions.
- [ ] T202: Crear Dockerfile multi-stage.

## [F3] Fuentes ola 1 + enrich
- [ ] T301: Añadir fuentes: wesome-list, nthropic-skills, mcp-registry, 
pm, hn.
- [ ] T302: Implementar enriquecimiento de datos (contributors, releases, licencias, riesgos).
- [ ] T303: Mejorar informes con secciones de riesgos y errores.
- [ ] T304: Adaptar spf prepare para fusionar múltiples semanas.

## [F4] Calibración
- [ ] T401: Implementar cambio de estados y revisión mensual de intereses.
- [ ] T402: Añadir fuentes ola 2 (crates, 
uget, eddit, logs, github-releases).
- [ ] T403: Tag 1.0.0.

## [F5] VPS + dominio
- [ ] T501: Configurar VPS, dominio y DNS.
- [ ] T502: Crear docker-compose.yml (worker, db, caddy).
- [ ] T503: Migrar Drizzle de SQLite a PostgreSQL.
- [ ] T504: Configurar acceso (Cloudflare Access o passkey).

## [F6] Web app
- [ ] T601: Inicializar app Next.js 15 y dependencias de UI.
- [ ] T602: Implementar dashboard de ejecuciones y vista de candidatos.
- [ ] T603: Implementar editor de interests.yaml y sincronización.
- [ ] T604: Tag 2.0.0.
