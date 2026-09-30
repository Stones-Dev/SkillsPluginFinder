---
aliases:
  - Intereses SkillsPluginFinder
  - interests.yaml
type: note
status: active
tags:
  - ia
  - claude-code
  - nextjs
  - react
  - rust
  - solana
  - dotnet
  - sage200
created: 2026-09-29
updated: 2026-09-29
related:
  - "[[SkillsPluginFinder]]"
  - "[[Catalogo]]"
project_id: skillspluginfinder
---

# Intereses — SkillsPluginFinder

**Fuente de verdad.** El pipeline lee el bloque YAML de abajo en cada ejecución. Cualquier agente (Claude Code, Antigravity, Claude Desktop) o la web app puede editarlo; el YAML debe seguir siendo válido según el esquema de `packages/core/src/config/schema.ts`.

Reglas de edición:
- Cambia `peso` (0-1) para priorizar categorías; `umbral_score` global por defecto 7.
- `keywords` son las consultas que se lanzan a cada fuente; `topics` son topics de GitHub.
- `contexto` (opcional por categoría) se copia tal cual al `batch.md` para que el agente entienda qué se busca más allá de las keywords.
- `excluir` acepta nombres de repos (`owner/repo`), paquetes o patrones; se suma automáticamente a lo que esté en [[Catalogo]] como `adoptado` o `descartado`.
- `proyectos` alimenta el prompt de scoring: una línea por proyecto activo, con su stack, para que la IA puntúe utilidad *para ellos*.

```yaml
version: 1
umbral_score: 7          # mínimo para publicar; no hay máximo (Clarify 2)
enrich_max: 80           # tope de candidatos enriquecidos por recogida (cuota de API de GitHub)
ventana_dias: 14            # novedades creadas/actualizadas en los últimos N días
idioma_informe: es

reglas_globales:
  estrellas_min: 50
  estrellas_max: 20000        # un repo que ya conoce todo el mundo no es un hallazgo
  ultimo_commit_max_dias: 90
  licencias_ok: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense]
  licencia_no_reconocida: riesgo   # NOASSERTION pasa con señal de riesgo en vez de descartarse
  excluir_forks_sin_cambios: true
  excluir_archivados: true

categorias:
  claude-skills:
    nombre: Skills y plugins para Claude y Claude Code
    peso: 1.0
    estrellas_min: 20            # ecosistema joven, umbral más bajo
    keywords: ["claude code skill", "claude code plugin", "claude skills", "SKILL.md", "claude code hooks", "claude code slash command", "claude plugin marketplace"]
    topics: [claude-code, claude-skills, claude-code-plugin, anthropic-claude]
  mcp-servers:
    nombre: Servidores MCP útiles para desarrollo
    peso: 1.0
    estrellas_min: 30
    keywords: ["mcp server", "model context protocol server", "mcp server typescript", "mcp server rust", "mcp server dotnet"]
    topics: [mcp, mcp-server, model-context-protocol]
  agent-skills:
    nombre: Agent skills (formato abierto, multiagente)
    peso: 0.8
    estrellas_min: 20
    keywords: ["agent skills", "agentskills", "SKILL.md", "codex skills", "gemini cli extension", "antigravity skill"]
    topics: [agent-skills, ai-agents, agentic-coding]
  nextjs-react:
    nombre: Next.js y React (librerías, plantillas, tooling)
    peso: 0.9
    keywords: ["nextjs 15", "next.js app router", "react 19", "react server components", "nextjs template", "nextjs boilerplate"]
    topics: [nextjs, react, app-router, react-server-components]
  frontend-bonito:
    nombre: Diseño de frontends atractivos en Next.js/React
    peso: 0.9
    keywords: ["react animation library", "framer motion alternative", "shadcn components", "design system react", "tailwind components", "landing page nextjs", "ui kit react", "design engineering skill"]
    topics: [tailwindcss, shadcn-ui, animation, design-system, ui-components, motion]
  rust:
    nombre: Rust (crates y herramientas)
    peso: 0.7
    keywords: ["rust crate", "rust cli", "rust web framework", "rust async", "tokio", "axum"]
    topics: [rust, rust-lang, crate]
  solana:
    nombre: Blockchain Solana
    peso: 0.8
    keywords: ["solana sdk", "solana rust", "anchor framework", "solana indexer", "solana mcp", "yellowstone grpc", "jupiter api", "solana typescript"]
    topics: [solana, anchor, web3, solana-program]
  dotnet:
    nombre: .NET
    peso: 0.6
    keywords: ["dotnet library", "asp.net core", "entity framework core", "csharp mcp", ".NET 8", "blazor"]
    topics: [dotnet, csharp, aspnetcore, efcore]
  sage200:
    nombre: Ideas para el proyecto Sage 200 MCP (MCPs y agentes sobre ERPs)
    peso: 0.7
    estrellas_min: 5             # nicho: casi no hay repos; cualquier cosa cuenta
    contexto: Buscar inspiración y piezas reutilizables para la idea [[Sage 200 MCP]] del vault; servidores MCP para ERPs (Sage, Odoo, SAP, Dynamics), conectores a SQL Server legado, patrones de agentes que leen y escriben en un ERP, herramientas de introspección de esquemas.
    keywords: ["sage 200", "sage200", "sage mcp", "erp mcp server", "odoo mcp", "sap mcp", "dynamics 365 mcp", "sql server mcp", "mssql mcp", "database schema mcp", "erp agent", "odbc erp integration", "cdata sage"]
    topics: [sage, erp, sqlserver, mssql, odoo, sap]
  librerias-relacionadas:
    nombre: Librerías transversales relacionadas
    peso: 0.5
    keywords: ["typescript library", "zod alternative", "drizzle orm", "developer tooling", "cli tool typescript"]
    topics: [typescript, developer-tools, nodejs]

excluir:
  - obra/superpowers            # ver Plugins Claude Code evaluados y descartados
  - garrytan/gstack
  - thedotmack/claude-mem
  - anthropics/skills            # ya conocido; se sigue por su changelog, no como hallazgo
  - "*/awesome-*"                # las listas son fuentes, no hallazgos

proyectos:
  - CRMDecoversia — CRM comercial, Laravel 11 backend + Node/Next.js frontend, JWT, colas, exports
  - AgentJobFinder — agente Python 3.12 (httpx, sqlmodel, apscheduler) + tracker FastAPI/Jinja2, redacción vía Claude Code
  - SonarTrench — bot de alertas memecoins Solana: Yellowstone gRPC, Rust/TS, Discord, web Next.js 15 con login wallet
  - Reproductor IPTV Multiplataforma — Flutter/Dart, drift, media_kit, sync serverless
  - UpdateTrackingEkipman — .NET 7 API + React, integración Sage 200 sobre SQL Server
  - EkipmanFirmaAlbaranes — webapp de firma de albaranes contra Sage 200, signotec, Graph API
  - Sage 200 MCP — servidor MCP abierto para Sage 200 (variante española) sobre SQL Server; primera implementación el caso Ekipman (pausado, buscando piezas e inspiración)
  - Auditor Web MCP — servidor MCP de auditoría web (web3 + GEO)
  - Laravel Dependency Doctor — servidor MCP en PHP para composer.json
  - LABE Abogados web — Next.js 15 + Tailwind, SEO/GEO/SEM
  - Vault Obsidian — agentes Claude Code, Antigravity y Claude Desktop operando vía Local REST API
```

## Notas de calibración

- 2026-09-30, primera ejecución real (Claude Code): 109 consultas → 906 repos únicos → 610 tras reglas → 80 enriquecidos, 530 diferidos. El tope se llenó de repos gigantes (42 de 80 con >10k★, mediana 14k) por consultas `topic:` ordenadas por estrellas: freeCodeCamp, react, rust-lang/rust. Añadido `estrellas_max: 20000` y prioridad de novedad en la selección para enrich. Revisar en F4 si el techo es correcto.
- 2026-09-30: 296 descartes, 268 por licencia (132 NOASSERTION, 61 AGPL, 32 sin licencia, 25 GPL). NOASSERTION pasa a señal de riesgo. Pendiente F4: para `kind` skill/plugin/mcp-server (se ejecutan, no se enlazan) valorar aceptar copyleft con aviso; para `library` mantener la lista blanca.
- 2026-09-30: `claude-skills` tenía 98 elegibles y solo 11 entraban por cuota; el reparto por peso no refleja el volumen real por categoría. Revisar cuotas en F4.
- Semana 1-4: no tocar pesos; anotar aquí qué hallazgos fueron ruido y por qué, y ajustar en bloque en la semana 4.
- Si una categoría devuelve 0 candidatos tres semanas seguidas, revisar `keywords`/`topics` antes que bajar `estrellas_min`.
- Añadir aquí (no en el repo) cualquier proyecto nuevo del vault para que el scoring lo tenga en cuenta.
