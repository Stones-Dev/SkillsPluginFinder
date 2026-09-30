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
updated: 2026-09-29
related:
  - "[[SkillsPluginFinder]]"
  - "[[Intereses]]"
  - "[[Plugins Claude Code evaluados y descartados]]"
  - "[[MOC Skills de Claude Code]]"
project_id: skillspluginfinder
---

# Catálogo de hallazgos — SkillsPluginFinder

Registro vivo. El pipeline **añade** filas con `estado: candidato` y rellena las columnas técnicas; **la columna `estado` la cambia solo el humano** (o la web app en fase 2). Estados: `candidato` → `probado` → `adoptado` | `descartado`. Todo lo `adoptado` o `descartado` queda excluido de futuros informes.

Los agentes que abran el vault deben consultar esta tabla antes de proponer una skill/plugin/librería: si ya está aquí, no se vuelve a proponer.

## Baseline (importado a mano el 2026-09-29)

Lo ya evaluado antes de existir el proyecto. Fuente: [[Plugins Claude Code evaluados y descartados]] y notas de [[MOC Skills de Claude Code]].

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

> Pendiente: completar el baseline con el resto de notas de [[MOC Skills de Claude Code]] y [[MOC Librerías Frontend]] (Impeccable, UI UX Pro Max, Taste Skill, Emil Design Engineering, UI Animation, Animation Designer, Anime.js, Three.js, Animate.css, HyperFrames…) con su estado real. Lo hace Stones o un agente en la primera sesión.

## Hallazgos

| Nombre | Tipo | Categoría | Estado | Semana | Score | Motivo / nota | Enlace |
|---|---|---|---|---|---|---|---|
