---
aliases:
  - Catálogo SkillsPluginFinder
  - Catálogo de hallazgos
type: note
status: active
tags:
  - ia
  - claude-code
created: 2026-09-29
updated: 2026-09-30
related:
  - "[[SkillsPluginFinder]]"
  - "[[Intereses]]"
  - "[[Plugins Claude Code evaluados y descartados]]"
  - "[[MOC Skills y plugins]]"
project_id: skillspluginfinder
---

# Catálogo de hallazgos — SkillsPluginFinder

Registro vivo. El pipeline **añade** filas con `estado: candidato` y rellena las columnas técnicas; **la columna `estado` la cambia solo el humano** (o la web app en fase 2). Estados: `candidato` → `probado` → `adoptado` | `descartado`. Todo lo `adoptado` o `descartado` queda excluido de futuros informes.

Los agentes que abran el vault deben consultar esta tabla antes de proponer una skill/plugin/librería: si ya está aquí, no se vuelve a proponer.

## Baseline (importado a mano el 2026-09-29)

Lo ya evaluado antes de existir el proyecto. Fuente: [[Plugins Claude Code evaluados y descartados]] y notas de [[MOC Skills y plugins]].

| Nombre | Tipo | Categoría | Estado | Semana | Score | Motivo / nota | Enlace |
|---|---|---|---|---|---|---|---|
| obra/superpowers | plugin | claude-skills | descartado | baseline | — | Choca con SDD estricto (ver nota de descartes) | https://github.com/obra/superpowers |
| garrytan/gstack | plugin | claude-skills | descartado | baseline | — | Fase ideación SaaS; solapa con codebase-memory-mcp | https://github.com/garrytan/gstack |
| thedotmack/claude-mem | plugin | claude-skills | descartado | baseline | — | Solapa con handoff.md + codebase-memory-mcp | https://github.com/thedotmack/claude-mem |
| Frontend Design (Anthropic) | skill | frontend-bonito | adoptado | baseline | — | Ver [[Frontend Design (skill de Anthropic)]] | — |
| Web Design Guidelines (Vercel) | skill | frontend-bonito | adoptado | baseline | — | Ver [[Web Design Guidelines (skill de Vercel)]] | — |
| Code Review (Anthropic) | plugin | claude-skills | adoptado | baseline | — | Ver [[Code Review (plugin oficial de Anthropic)]] | — |
| Security Guidance (Anthropic) | plugin | claude-skills | adoptado | baseline | — | Ver [[Security Guidance (plugin oficial de Anthropic)]] | — |
| codebase-memory-mcp (DeusData) | mcp-server | mcp-servers | adoptado | baseline | — | Ver [[Codebase-memory-mcp (servidor MCP de DeusData)]] | — |
| Spec Kit | tool | claude-skills | adoptado | baseline | — | Protocolo 11 del vault | — |

> Pendiente: completar el baseline con el resto de notas de [[MOC Skills y plugins]] y [[MOC Librerías]] (Impeccable, UI UX Pro Max, Taste Skill, Emil Design Engineering, UI Animation, Animation Designer, Anime.js, Three.js, Animate.css, HyperFrames…) con su estado real. Lo hace Stones o un agente en la primera sesión.

## Hallazgos

| Nombre | Tipo | Categoría | Estado | Semana | Score | Motivo / nota | Enlace |
|---|---|---|---|---|---|---|---|
| solanabr/ai-kit | skill | solana | candidato | 2026-W40 | 8 | Configuración completa de Claude Code para Solana: CLAUDE.md compacto, 15 agentes, 31 comandos y skills, con un agente rust-backend-engineer para APIs Axum, indexadores y servicios WebSocket, un agen… | https://github.com/solanabr/ai-kit |
| AndyShiu/claude-skill-playwright-browser | skill | claude-skills | candidato | 2026-W40 | 7 | Da a Claude Code un navegador en segundo plano para capturas en varios tamaños, health checks (errores de consola, desbordes en móvil, accesibilidad con axe, LCP y CLS) y diffs visuales. Encaja con L… | https://github.com/AndyShiu/claude-skill-playwright-browser |
| crbnos/carbon | mcp-server | sage200 | candidato | 2026-W40 | 7 | ERP de fabricación con API REST y servidor MCP sobre un único esquema Postgres: expone más de 1.500 operaciones tipadas como herramientas MCP limitadas a los permisos de la clave o del usuario, con c… | https://github.com/crbnos/carbon |
| kuratlielia/arc-library | library | frontend-bonito | candidato | 2026-W40 | 7 | Cien componentes y 22 bloques de código propio con movimiento sereno, teclado y camino para movimiento reducido, instalables con la CLI de shadcn. Un movimiento contenido encaja con una web de despac… | https://github.com/kuratlielia/arc-library |
| next-safe-action/next-safe-action | library | nextjs-react | candidato | 2026-W40 | 7 | Server Actions de Next.js con validación zod, middleware y manejo de errores tipado. Encaja con el login por wallet de la web de SonarTrench, el formulario de contacto de LABE Abogados web y las muta… | https://github.com/next-safe-action/next-safe-action |
| solana-foundation/solana-web3.js | library | solana | candidato | 2026-W40 | 7 | SDK oficial de Solana en TypeScript. La rama 1.x solo recibe correcciones críticas y el desarrollo nuevo está en la v3, en este repositorio bajo solana-foundation, lo que afecta a la web de SonarTren… | https://github.com/solana-foundation/solana-web3.js |
