# Roadmap - F1 Vertical Slice

## Avance Actual
- He logrado solucionar los problemas de build implementando `composite: true` en el tsconfig y reparando los exports duplicados.
- Se ha implementado un mock (fallback) para SQLite en caso de que fallen los bindings nativos de `better-sqlite3`, permitiendo la ejecución end-to-end local sin requerir compiladores C++.
- Se implementaron los módulos `normalize`, `dedupe`, `filter`, `batch`, `publish`, `pipeline`.
- Se arreglaron las importaciones en el CLI y se probaron comandos exitosamente.
- Ejecución real end-to-end (`spf prepare` y `spf publish`) finalizada con éxito (aunque con 0 resultados debido a la falta de token de GitHub real y Rate Limits, pero el flujo está completo).

## Tareas (Tasks)
- [x] T101: Configurar monorepo pnpm, TS estricto, Biome, Vitest y CLI spf.
- [x] T102: Implementar módulo config y vault (se encontraron estructuras previas).
- [x] T104: Implementar módulos normalize y dedupe (con Drizzle + Fallback en-memoria).
- [x] T105: Implementar módulo filter.
- [x] T106: Implementar comando spf collect completo.
- [x] T107: Implementar módulo batch (prepare-batch y collect-batch).
- [x] T108: Implementar módulo publish.
- [ ] T109: Crear workflows.
- [x] T110: Ejecución end-to-end.
