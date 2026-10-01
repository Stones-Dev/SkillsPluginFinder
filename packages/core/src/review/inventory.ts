import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { Signal, SignalType } from './signals.js';
import { uniqueSignals } from './signals.js';
import { type TreeFile, walkTree } from './tree.js';

// Todo lo que hace este módulo es leer: nunca se ejecuta, instala ni importa nada
// del repositorio revisado (Constitución §1). Los ficheros se tratan como texto y
// se interpretan solo con JSON.parse y `yaml` (que no ejecuta código). Ojo: no usar
// gray-matter con ficheros de terceros, porque evalúa JavaScript en un frontmatter `---js`.

const MAX_TEXT = 256 * 1024;
const MAX_SCANNED = 100;

const INSTALL_LIFECYCLE = ['preinstall', 'install', 'postinstall'] as const;

/** Scripts de instalación con nombre típico, a lo sumo dos carpetas por debajo de la raíz. */
const INSTALL_FILE =
  /^(install|setup|bootstrap|postinstall|preinstall)([._-][\w.-]*)?\.(sh|bash|zsh|ps1|psm1|bat|cmd|mjs|cjs|js|py|rb)$/i;
const NOT_INSTALL_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'fixtures',
  'docs',
  'doc',
  'examples',
  'example',
]);
const MAX_INSTALL_DEPTH = 3; // segmentos de la ruta: scripts/setup.mjs = 2

/** `git+…`, `github:…`, `https://…`, `file:…` o la forma corta `owner/repo`. */
const NON_REGISTRY_DEP =
  /^(git\+|git:|git@|github:|gitlab:|bitbucket:|https?:|file:|link:|portal:|[\w.-]+\/[\w.-]+(#.+)?$)/i;

const STANDARD_NPM_REGISTRIES =
  /(^|\/\/)(registry\.npmjs\.org|registry\.yarnpkg\.com)(\/|$)/i;
const REMOTE_TRANSPORTS = new Set(['http', 'sse', 'streamable-http']);
const BINARY_EXT = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.wasm',
  '.bin',
  '.jar',
  '.class',
  '.o',
  '.a',
  '.msi',
  '.dmg',
  '.pkg',
  '.apk',
]);

export type Inventory = {
  tree: {
    files: number;
    bytes: number;
    truncated: boolean;
    porExtension: [string, number][];
    mayores: TreeFile[];
  };
  /** Manifiestos y ficheros de configuración que se leyeron. */
  manifiestos: string[];
  /** Observaciones que no bloquean `adoptado` pero conviene ver. */
  notas: string[];
  signals: Signal[];
};

const ext = (p: string) => path.posix.extname(p).toLowerCase();
const base = (p: string) => path.posix.basename(p);

async function readText(root: string, rel: string): Promise<string | null> {
  const file = path.join(root, ...rel.split('/'));
  const { size } = await fs.stat(file);
  if (size > MAX_TEXT) return null;
  const text = await fs.readFile(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Cada valor de `key` en cualquier punto del JSON (hasta cierta profundidad). */
function findKey(value: unknown, key: string, depth = 0): unknown[] {
  if (depth > 6 || typeof value !== 'object' || value === null) return [];
  const found: unknown[] = [];
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  for (const [k, v] of entries) {
    if (k === key) found.push(v);
    found.push(...findKey(v, key, depth + 1));
  }
  return found;
}

/** Bloque de frontmatter YAML de un `.md`, o `{}` si no hay o no es válido. */
function frontmatterOf(text: string): Record<string, unknown> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1]);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** `Bash` sin restricción: ni paréntesis ni un patrón que lo deje abierto. */
function isWideBash(tool: string): boolean {
  return /^Bash$/.test(tool) || /^Bash\(\s*(\*+|:\*|\*:\*)?\s*\)$/.test(tool);
}

function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim());
  if (typeof value === 'string') {
    return value.match(/[A-Za-z_*]+(?:\([^)]*\))?/g) ?? [];
  }
  return [];
}

const short = (text: string, max = 80) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const hostOf = (url: string) => url.match(/^[a-z]+:\/\/([^/\s"']+)/i)?.[1];

/**
 * Inventario automático de un clon (Plan §7 bis, punto 2): árbol, manifiestos,
 * scripts de instalación, permisos declarados y las señales de supply-chain de
 * la Constitución §1 que se pueden deducir leyendo ficheros.
 */
export async function inspectRepo(root: string): Promise<Inventory> {
  const tree = await walkTree(root);
  const signals: Signal[] = [];
  const notas: string[] = [];
  const manifiestos: string[] = [];

  const signal = (tipo: SignalType, detalle: string) =>
    signals.push({ tipo, detalle, fuente: 'inventario' });
  const read = async (rel: string) => {
    manifiestos.push(rel);
    return readText(root, rel);
  };
  const where = (rel: string) => (rel.includes('/') ? rel : `${rel} (raíz)`);

  const files = tree.files;
  const named = (pred: (p: string) => boolean) =>
    files.filter((f) => pred(f.path)).slice(0, MAX_SCANNED);

  // --- árbol ---------------------------------------------------------------
  const byExt = new Map<string, number>();
  for (const f of files) {
    const e = ext(f.path) || '(sin extensión)';
    byExt.set(e, (byExt.get(e) ?? 0) + 1);
  }
  const binarios = files.filter((f) => BINARY_EXT.has(ext(f.path)));
  if (binarios.length > 0) {
    notas.push(
      `Binarios commiteados (${binarios.length}): ${binarios
        .slice(0, 5)
        .map((f) => f.path)
        .join(', ')}${binarios.length > 5 ? '…' : ''}`,
    );
  }
  if (tree.truncated) {
    notas.push(
      'El árbol es muy grande: se recorrieron solo los primeros ficheros.',
    );
  }

  // --- package.json (todos los de la raíz y de los paquetes) ----------------
  for (const f of named((p) => base(p) === 'package.json')) {
    const text = await read(f.path);
    const pkg = text === null ? undefined : parseJson(text);
    if (!isObject(pkg)) {
      notas.push(`${f.path} no se pudo leer como JSON.`);
      continue;
    }
    const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
    for (const name of INSTALL_LIFECYCLE) {
      if (typeof scripts[name] === 'string') {
        signal(
          'install-script',
          `${f.path}: script de ciclo de instalación ${name} = ${short(String(scripts[name]))}`,
        );
      }
    }
    if (Object.keys(scripts).length > 0) {
      notas.push(`${f.path}: scripts ${Object.keys(scripts).join(', ')}`);
    }
    if (pkg.bin) notas.push(`${f.path} declara ejecutables (bin).`);

    const nonRegistry: string[] = [];
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const deps = pkg[field];
      if (!isObject(deps)) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === 'string' && NON_REGISTRY_DEP.test(spec)) {
          nonRegistry.push(`${name}@${short(spec, 50)}`);
        }
      }
    }
    if (nonRegistry.length > 0) {
      signal(
        'registro-propio',
        `${f.path}: dependencias que no vienen del registro (${nonRegistry.slice(0, 3).join(', ')}${nonRegistry.length > 3 ? '…' : ''})`,
      );
    }
    const publishRegistry = isObject(pkg.publishConfig)
      ? pkg.publishConfig.registry
      : undefined;
    if (
      typeof publishRegistry === 'string' &&
      !STANDARD_NPM_REGISTRIES.test(publishRegistry)
    ) {
      signal(
        'registro-propio',
        `${f.path}: publishConfig.registry = ${short(publishRegistry)}`,
      );
    }
  }

  // --- registros de paquetes: .npmrc, .yarnrc.yml, registro shadcn ----------
  for (const f of named((p) => base(p) === '.npmrc')) {
    const text = await read(f.path);
    for (const m of (text ?? '').matchAll(
      /^\s*(?:@[\w.-]+:)?registry\s*=\s*(\S+)/gim,
    )) {
      if (!STANDARD_NPM_REGISTRIES.test(m[1])) {
        signal('registro-propio', `${f.path}: registry = ${short(m[1])}`);
      }
    }
  }
  for (const f of named((p) => base(p) === '.yarnrc.yml')) {
    const text = await read(f.path);
    for (const m of (text ?? '').matchAll(
      /npmRegistryServer:\s*["']?([^\s"']+)/g,
    )) {
      if (!STANDARD_NPM_REGISTRIES.test(m[1])) {
        signal(
          'registro-propio',
          `${f.path}: npmRegistryServer = ${short(m[1])}`,
        );
      }
    }
  }
  for (const f of named((p) => p === 'registry.json')) {
    const text = await read(f.path);
    const json = text === null ? undefined : parseJson(text);
    if (
      isObject(json) &&
      (Array.isArray(json.items) ||
        String(json.$schema ?? '').includes('registry'))
    ) {
      signal(
        'registro-propio',
        `${f.path}: el repositorio es un registro de componentes propio (shadcn) desde el que se instala con la CLI`,
      );
    }
  }
  for (const f of named((p) => base(p) === 'components.json')) {
    const text = await read(f.path);
    const json = text === null ? undefined : parseJson(text);
    if (isObject(json) && isObject(json.registries)) {
      for (const [name, url] of Object.entries(json.registries)) {
        signal(
          'registro-propio',
          `${f.path}: registro shadcn ${name} = ${short(JSON.stringify(url))}`,
        );
      }
    }
  }

  // --- Rust, .NET y Python -------------------------------------------------
  for (const f of named((p) => base(p) === 'Cargo.toml')) {
    const text = (await read(f.path)) ?? '';
    if (/^\s*build\s*=\s*"/m.test(text)) {
      signal(
        'install-script',
        `${f.path}: declara un build script (se ejecuta al compilar)`,
      );
    }
    if (/\bgit\s*=\s*"/.test(text)) {
      signal('registro-propio', `${f.path}: dependencias de Rust desde git`);
    }
    if (/^\s*\[registries/m.test(text)) {
      signal('registro-propio', `${f.path}: registros de Cargo propios`);
    }
  }
  for (const f of named((p) => base(p) === 'build.rs')) {
    manifiestos.push(f.path);
    signal('install-script', `${f.path}: build.rs ejecuta código al compilar`);
  }
  for (const f of named((p) => /(^|\/)\.cargo\/config(\.toml)?$/.test(p))) {
    const text = (await read(f.path)) ?? '';
    if (/\[registries|replace-with/.test(text)) {
      signal(
        'registro-propio',
        `${f.path}: configuración de registros de Cargo`,
      );
    }
  }
  for (const f of named((p) =>
    ['.csproj', '.vbproj', '.fsproj', '.targets', '.props'].includes(ext(p)),
  )) {
    const text = (await read(f.path)) ?? '';
    if (/<Exec\b/.test(text)) {
      signal(
        'install-script',
        `${f.path}: tarea MSBuild <Exec> que ejecuta comandos al compilar`,
      );
    }
  }
  for (const f of named((p) => /^nuget\.config$/i.test(base(p)))) {
    const text = (await read(f.path)) ?? '';
    for (const m of text.matchAll(/<add\b[^>]*\bvalue="(https?:[^"]+)"/gi)) {
      if (!/nuget\.org/i.test(hostOf(m[1]) ?? '')) {
        signal('registro-propio', `${f.path}: fuente NuGet ${short(m[1])}`);
      }
    }
  }
  for (const f of named(
    (p) =>
      /^requirements.*\.txt$/i.test(base(p)) ||
      base(p) === 'pyproject.toml' ||
      base(p) === 'pip.conf',
  )) {
    const text = (await read(f.path)) ?? '';
    if (
      /--(extra-)?index-url|\[\[tool\.uv\.index\]\]|\[\[tool\.poetry\.source\]\]/.test(
        text,
      )
    ) {
      signal(
        'registro-propio',
        `${f.path}: índice de paquetes de Python propio`,
      );
    }
  }

  // --- scripts de instalación por nombre -----------------------------------
  const installFiles = named((p) => {
    const segments = p.split('/');
    return (
      segments.length <= MAX_INSTALL_DEPTH &&
      INSTALL_FILE.test(base(p)) &&
      !segments.slice(0, -1).some((s) => NOT_INSTALL_DIRS.has(s.toLowerCase()))
    );
  });
  for (const f of installFiles) {
    signal(
      'install-script',
      `${where(f.path)}: script de instalación o preparación`,
    );
  }

  // Privilegios y descargas en los scripts de instalación y en los .sh/.ps1/.bat.
  const shellScripts = named(
    (p) =>
      p.split('/').length <= MAX_INSTALL_DEPTH &&
      ['.sh', '.bash', '.ps1', '.bat', '.cmd'].includes(ext(p)),
  );
  for (const f of [
    ...new Map(
      [...installFiles, ...shellScripts].map((x) => [x.path, x]),
    ).values(),
  ]) {
    const text = await readText(root, f.path);
    if (text === null) continue;
    if (/\bsudo\b/.test(text)) {
      signal('privilegios', `${f.path}: usa sudo`);
    }
    if (/-Verb\s+RunAs|requireAdministrator/i.test(text)) {
      signal('privilegios', `${f.path}: pide ejecutarse como administrador`);
    }
    if (/--dangerously-skip-permissions/.test(text)) {
      signal('privilegios', `${f.path}: usa --dangerously-skip-permissions`);
    }
    if (/\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b/.test(text)) {
      notas.push(`${f.path}: descarga y ejecuta código remoto (curl | sh).`);
    }
  }

  // --- MCP: servidores remotos ---------------------------------------------
  const mcpFiles = named((p) =>
    [
      '.mcp.json',
      'mcp.json',
      'plugin.json',
      'marketplace.json',
      'server.json',
    ].includes(base(p)),
  );
  for (const f of mcpFiles) {
    const text = await read(f.path);
    const json = text === null ? undefined : parseJson(text);
    if (json === undefined) continue;
    for (const servers of findKey(json, 'mcpServers')) {
      if (!isObject(servers)) continue;
      for (const [name, s] of Object.entries(servers)) {
        if (!isObject(s)) continue;
        const transport = String(s.type ?? s.transport ?? '').toLowerCase();
        const cmd = [s.command, ...(Array.isArray(s.args) ? s.args : [])].join(
          ' ',
        );
        if (
          typeof s.url === 'string' ||
          REMOTE_TRANSPORTS.has(transport) ||
          /\bmcp-remote\b/.test(cmd)
        ) {
          signal(
            'mcp-remoto',
            `${f.path}: el servidor MCP ${name} es remoto (${short(String(s.url ?? cmd))})`,
          );
        } else if (/\bnpx\b/.test(cmd) && /@latest\b|\s-y\b/.test(cmd)) {
          notas.push(
            `${f.path}: el servidor MCP ${name} se lanza con ${short(cmd)} (sin versión fijada).`,
          );
        }
      }
    }
    if (
      base(f.path) === 'server.json' &&
      isObject(json) &&
      Array.isArray(json.remotes) &&
      json.remotes.length > 0
    ) {
      signal(
        'mcp-remoto',
        `${f.path}: el servidor declara remotos (${json.remotes.length})`,
      );
    }
  }
  for (const f of named((p) => !p.includes('/') && ext(p) === '.md').slice(
    0,
    10,
  )) {
    const text = await readText(root, f.path);
    if (
      text !== null &&
      /--transport[ =]+(http|sse|streamable-http)\b|\bmcp-remote\b/i.test(text)
    ) {
      signal(
        'mcp-remoto',
        `${f.path}: la documentación configura un servidor MCP remoto`,
      );
    }
  }

  // --- permisos declarados: skills, agentes, comandos, ajustes y hooks ------
  const promptFiles = named(
    (p) =>
      ext(p) === '.md' &&
      (base(p) === 'SKILL.md' ||
        /(^|\/)(commands|agents|skills)\/.+\.md$/i.test(p)),
  );
  for (const f of promptFiles) {
    const text = await readText(root, f.path);
    if (text === null) continue;
    const fm = frontmatterOf(text);
    const tools = toolList(fm['allowed-tools'] ?? fm.allowedTools ?? fm.tools);
    if (tools.length > 0) {
      notas.push(`${f.path}: herramientas declaradas ${tools.join(', ')}`);
    }
    if (tools.some(isWideBash)) {
      signal('privilegios', `${f.path}: declara Bash sin restringir`);
    }
  }
  for (const f of named(
    (p) =>
      ext(p) === '.json' &&
      (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(p) ||
        ['plugin.json', 'hooks.json'].includes(base(p))),
  )) {
    const text = await readText(root, f.path);
    const json = text === null ? undefined : parseJson(text);
    if (!isObject(json)) continue;
    if (!manifiestos.includes(f.path)) manifiestos.push(f.path);
    const hookCommands = findKey(json, 'hooks').flatMap((h) =>
      findKey(h, 'command').filter((c) => typeof c === 'string'),
    );
    if (hookCommands.length > 0) {
      signal(
        'privilegios',
        `${f.path}: hooks que ejecutan comandos (${hookCommands.length})`,
      );
    }
    const permissions = json.permissions;
    if (isObject(permissions)) {
      const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
      if (
        allow.some((a) => typeof a === 'string' && (isWideBash(a) || a === '*'))
      ) {
        signal(
          'privilegios',
          `${f.path}: permissions.allow concede herramientas sin restringir`,
        );
      }
      if (permissions.defaultMode === 'bypassPermissions') {
        signal('privilegios', `${f.path}: defaultMode bypassPermissions`);
      }
    }
  }

  // --- otras observaciones --------------------------------------------------
  for (const f of named((p) => p === '.gitmodules')) {
    const text = (await read(f.path)) ?? '';
    const urls = [...text.matchAll(/^\s*url\s*=\s*(\S+)/gm)].map((m) => m[1]);
    notas.push(
      `${f.path}: ${urls.length} submódulos de terceros (el clon no los descarga): ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? '…' : ''}`,
    );
  }
  for (const f of named(
    (p) => /^(Dockerfile|Makefile)$/.test(base(p)) && !p.includes('/'),
  )) {
    notas.push(`${f.path} en la raíz.`);
  }

  const mayores = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
  return {
    tree: {
      files: files.length,
      bytes: tree.bytes,
      truncated: tree.truncated,
      porExtension: [...byExt.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
      mayores,
    },
    manifiestos: [...new Set(manifiestos)].sort(),
    notas,
    signals: uniqueSignals(signals),
  };
}
