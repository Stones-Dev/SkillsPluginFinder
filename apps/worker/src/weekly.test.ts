import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const isWindows = process.platform === 'win32';

const runner = read('scripts/run-weekly.ps1');
const scheduler = read('scripts/schedule-windows.ps1');
const settings = JSON.parse(read('.claude/settings.weekly.json')) as {
  permissions: { allow: string[]; deny: string[] };
};
const workflows = {
  'evaluar-semana': read('.agent/workflows/evaluar-semana.md'),
  'revisar-hallazgos': read('.agent/workflows/revisar-hallazgos.md'),
  'cruzar-evaluaciones': read('.agent/workflows/cruzar-evaluaciones.md'),
};

const nonAscii = (text: string) =>
  [...text].filter((c) => (c.codePointAt(0) ?? 0) > 127);

describe.each([
  ['scripts/run-weekly.ps1', runner],
  ['scripts/schedule-windows.ps1', scheduler],
])('%s', (file, text) => {
  test('es solo ASCII (Windows PowerShell 5.1 lee los .ps1 sin BOM como ANSI)', () => {
    expect(nonAscii(text)).toEqual([]);
  });

  test.skipIf(!isWindows)('parsea sin errores (sin ejecutarlo)', () => {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, file)}',[ref]$t,[ref]$e)|Out-Null;if($e.Count -gt 0){$e|ForEach-Object{$_.Message+' @'+$_.Extent.StartLineNumber};exit 1}`,
      ],
      { encoding: 'utf8' },
    );
    expect(r.stdout + r.stderr, 'errores de sintaxis').toBe('');
    expect(r.status).toBe(0);
  });
});

test('schedule-windows.ps1 registra las dos tareas del lunes, con las condiciones acordadas, y se puede deshacer', () => {
  expect(scheduler).toContain('"$TaskPrefix - evaluar semana (lunes 09:00)"');
  expect(scheduler).toContain("Mode = 'first'; At = '09:00'");
  expect(scheduler).toContain('"$TaskPrefix - reintento (lunes 12:00)"');
  expect(scheduler).toContain("Mode = 'retry'; At = '12:00'");
  expect(scheduler).toContain('-Weekly -DaysOfWeek Monday');
  expect(scheduler).toContain('run-weekly.ps1');
  expect(scheduler).toContain('-LogonType Interactive'); // Proton Drive solo está montado con la sesión iniciada
  expect(scheduler).toContain('StartWhenAvailable');
  expect(scheduler).toContain('ExecutionTimeLimit');
  expect(scheduler).toContain("MultipleInstances          = 'IgnoreNew'");
  expect(scheduler).toContain('SupportsShouldProcess'); // -WhatIf para ver qué haría sin registrar
  expect(scheduler).toContain('-Unregister');
  // claude -p lo lanza el runner, con la allowlist; el programador no toca permisos
  expect(scheduler).not.toContain('dangerously');
  expect(scheduler).not.toContain('claude.exe');
  // lo único que lanza la tarea es el runner, con su modo
  expect(scheduler).toContain('-File `"$runner`" -Mode $($t.Mode)');
});

test('run-weekly.ps1 lanza claude -p /evaluar-semana con la allowlist, el vault y sin pushear', () => {
  expect(runner).toContain('\'-p\', "/evaluar-semana $Week"');
  expect(runner).toContain("'--settings', $settings");
  expect(runner).toContain('settings.weekly.json');
  expect(runner).toContain("'--add-dir', $vaultRoot");
  expect(runner).toContain("'--no-session-persistence'");
  expect(runner).toContain("'pull', '--ff-only'");
  expect(runner).not.toMatch(/'push'|dangerously-skip-permissions/);
  // el reintento decide con `spf status`
  expect(runner).toContain("'status', '--week', $Week");
  expect(runner).toContain('data\\logs');
});

describe('.claude/settings.weekly.json', () => {
  const { allow, deny } = settings.permissions;
  /** Una regla `Bash(prefijo:*)` o `Bash(comando exacto)` permite este comando. */
  const allows = (command: string) =>
    allow.some((rule) => {
      const m = rule.match(/^Bash\((.*)\)$/);
      if (!m) return false;
      return m[1].endsWith(':*')
        ? command.startsWith(m[1].slice(0, -2))
        : command === m[1];
    });

  test('no concede Bash sin restringir y deniega push, tags, borrados y red por shell', () => {
    expect(allow).not.toContain('Bash');
    expect(allow.some((r) => /^Bash\(\*/.test(r))).toBe(false);
    for (const rule of [
      'Bash(git push:*)',
      'Bash(git tag:*)',
      'Bash(rm:*)',
      'Bash(curl:*)',
      'Bash(npm:*)',
      'Bash(npx:*)',
      'Bash(pnpm install:*)',
      'Read(./.env)',
      'Edit(./.env)',
    ]) {
      expect(deny, rule).toContain(rule);
    }
    // nada permitido está también denegado
    for (const rule of allow) expect(deny).not.toContain(rule);
  });

  test('WebFetch solo para dominios de lectura concretos', () => {
    const fetches = allow.filter((r) => r.startsWith('WebFetch'));
    expect(fetches.length).toBeGreaterThan(0);
    for (const r of fetches) expect(r).toMatch(/^WebFetch\(domain:[a-z.]+\)$/);
  });

  test('el MCP de Obsidian es solo de lectura y búsqueda', () => {
    const mcp = allow.filter((r) => r.startsWith('mcp__'));
    expect(mcp.length).toBeGreaterThan(0);
    for (const r of mcp)
      expect(r).toMatch(
        /^mcp__obsidian__(vault_read|vault_list|search_simple|search_query|vault_get_document_map)$/,
      );
  });

  /** Órdenes que los workflows mandan ejecutar (no las menciones en las reglas de lo prohibido). */
  const instructed = (text: string) =>
    [
      ...text.matchAll(
        /`((?:pnpm spf|git (?:pull|add|status|diff|log|commit)|powershell)[^`]*)`/g,
      ),
    ].map((m) => m[1]);

  test('cada comando de shell que mandan los workflows desatendidos está permitido', () => {
    const cited = Object.values(workflows).flatMap(instructed);
    expect(cited.length).toBeGreaterThan(15);

    const unsupported: string[] = [];
    for (const raw of cited) {
      // la nota del commit entre comillas no cambia el prefijo que se permite
      const command = raw.replace(/ "[^"]*"$/, '').trim();
      if (!allows(command) && !allows(raw)) unsupported.push(raw);
    }
    expect(unsupported).toEqual([]);
  });

  test('git push y git clone solo aparecen en los workflows como cosa prohibida, y la allowlist los deniega', () => {
    for (const [name, text] of Object.entries(workflows)) {
      for (const m of text.matchAll(/`(git (?:push|clone))`/g)) {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 90), m.index);
        expect(
          /No hagas|nunca|Nunca|no /.test(before),
          `${name}: «${m[1]}» sin negación delante`,
        ).toBe(true);
      }
    }
    expect(deny).toContain('Bash(git push:*)');
    expect(deny).toContain('Bash(git clone:*)');
  });

  test('las órdenes de git de los workflows son exactamente las de la allowlist', () => {
    for (const [name, text] of Object.entries(workflows)) {
      for (const git of instructed(text).filter((c) => c.startsWith('git '))) {
        if (git.startsWith('git commit -m')) continue;
        expect(
          [
            'git pull --ff-only',
            'git add data interests.yaml catalog.json',
          ].includes(git) || /^git (status|diff|log)/.test(git),
          `${name}: «${git}» no está en la allowlist`,
        ).toBe(true);
      }
    }
    expect(workflows['evaluar-semana']).toContain('`git pull --ff-only`');
    expect(allows('git pull')).toBe(false); // el pull sin --ff-only quedaría denegado: el workflow no lo usa
  });
});

// El `claude` y el `pnpm` de estas pruebas se escriben en un directorio temporal en tiempo
// de ejecución: dobles de herramientas externas, no ficheros del repo.
const FAKE_PNPM = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['pnpm', ...args]) + '\\n');
if (args.includes('week')) { console.log(process.env.FAKE_WEEK || '2026-W41'); process.exit(0); }
if (args.includes('status')) { console.log('Semana ' + args[args.indexOf('--week') + 1] + ': estado simulado'); process.exit(Number(process.env.FAKE_STATUS ?? 1)); }
process.exit(0);
`;
const FAKE_CLAUDE = `
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['claude', ...process.argv.slice(2)]) + '\\n');
if (process.env.FAKE_CLAUDE_SLEEP) { setTimeout(() => {}, 60000); return; }
console.log('flujo simulado');
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
`;

describe.skipIf(!isWindows)(
  'scripts/run-weekly.ps1 con claude y pnpm de prueba',
  () => {
    let tmp: string;
    let repo: string;
    let vaultRoot: string;
    let calls: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-weekly-'));
      repo = path.join(tmp, 'repo');
      vaultRoot = path.join(tmp, 'Cerebro');
      calls = path.join(tmp, 'calls.jsonl');
      fs.mkdirSync(repo);
      fs.mkdirSync(path.join(vaultRoot, '02-Proyectos', 'SkillsPluginFinder'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(tmp, 'fake-pnpm.js'), FAKE_PNPM);
      fs.writeFileSync(path.join(tmp, 'fake-claude.js'), FAKE_CLAUDE);
      fs.writeFileSync(calls, '');
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    function run(
      mode: string,
      env: Record<string, string> = {},
      extra: string[] = [],
      claude: { exe: string; prefix: string[] } = {
        exe: process.execPath,
        prefix: [path.join(tmp, 'fake-claude.js')],
      },
    ) {
      const r = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(root, 'scripts', 'run-weekly.ps1'),
          '-Mode',
          mode,
          '-RepoRoot',
          repo,
          '-SkipPull',
          '-Claude',
          claude.exe,
          ...(claude.prefix.length > 0
            ? ['-ClaudePrefixArgs', ...claude.prefix]
            : []),
          '-Pnpm',
          process.execPath,
          '-PnpmPrefixArgs',
          path.join(tmp, 'fake-pnpm.js'),
          ...extra,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            VAULT_PATH: path.join(
              vaultRoot,
              '02-Proyectos',
              'SkillsPluginFinder',
            ),
            FAKE_CALLS: calls,
            ...env,
          },
          timeout: 120_000,
        },
      );
      return { code: r.status, out: r.stdout + r.stderr };
    }
    const calledWith = (who: string) =>
      fs
        .readFileSync(calls, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
        .filter((c) => c[0] === who);
    const logText = () => {
      const dir = path.join(repo, 'data', 'logs');
      return fs
        .readdirSync(dir)
        .filter((f) => /^weekly-.*\d\.log$/.test(f))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n');
    };

    test('first con la semana sin cerrar: lanza claude -p /evaluar-semana con la allowlist y el vault', () => {
      const r = run('first', { FAKE_STATUS: '1', FAKE_WEEK: '2026-W41' });

      expect(r.code, r.out).toBe(0);
      const [claude] = calledWith('claude');
      expect(claude).toEqual([
        'claude',
        '-p',
        '/evaluar-semana 2026-W41',
        '--settings',
        path.join(repo, '.claude', 'settings.weekly.json'),
        '--add-dir',
        vaultRoot,
        '--no-session-persistence',
        '--output-format',
        'text',
      ]);
      const log = logText();
      expect(log).toContain('modo first');
      expect(log).toContain('semana 2026-W41');
      expect(log).toContain('RESULTADO (0)');
      // los logs de claude quedan en data/logs
      const files = fs.readdirSync(path.join(repo, 'data', 'logs'));
      expect(files.some((f) => f.endsWith('.claude.out.txt'))).toBe(true);
      expect(
        fs.readFileSync(
          path.join(
            repo,
            'data',
            'logs',
            files.find((f) => f.endsWith('.claude.out.txt')) as string,
          ),
          'utf8',
        ),
      ).toContain('flujo simulado');
    });

    test('retry con la semana sin cerrar también lanza el flujo; con la semana cerrada (0) no lanza nada', () => {
      const open = run('retry', { FAKE_STATUS: '1' });
      expect(open.code, open.out).toBe(0);
      expect(calledWith('claude')).toHaveLength(1);

      fs.writeFileSync(calls, '');
      const closed = run('retry', { FAKE_STATUS: '0' });
      expect(closed.code, closed.out).toBe(0);
      expect(calledWith('claude')).toHaveLength(0);
      expect(logText()).toContain('ya esta cerrada: nada que hacer');
    });

    test('first con la semana ya cerrada tampoco repite el flujo', () => {
      const r = run('first', { FAKE_STATUS: '0' });

      expect(r.code, r.out).toBe(0);
      expect(calledWith('claude')).toHaveLength(0);
    });

    test('sin recogida (status 2): first sale con 12 (la nube aún no recogió) y retry con 0; ninguno lanza claude', () => {
      expect(run('first', { FAKE_STATUS: '2' }).code).toBe(12);
      expect(run('retry', { FAKE_STATUS: '2' }).code).toBe(0);
      expect(calledWith('claude')).toHaveLength(0);
      expect(logText()).toContain('nada que evaluar todavia');
    });

    test('si claude sale con error (4) se avisa y se mira el estado final', () => {
      const r = run('first', { FAKE_STATUS: '1', FAKE_CLAUDE_EXIT: '7' });

      expect(r.code, r.out).toBe(4);
      expect(logText()).toContain('claude salio con codigo 7');
      expect(logText()).toContain('spf status final');
    });

    test('si claude no termina a tiempo (3) se mata el proceso', () => {
      const r = run('first', { FAKE_STATUS: '1', FAKE_CLAUDE_SLEEP: '1' }, [
        '-TimeoutSeconds',
        '2',
      ]);

      expect(r.code, r.out).toBe(3);
      expect(logText()).toContain('proceso matado');
    });

    test('--Model y --Week se pasan; y un código de status inesperado no lanza nada (14)', () => {
      const ok = run('first', { FAKE_STATUS: '1' }, [
        '-Week',
        '2026-W42',
        '-Model',
        'sonnet',
      ]);
      expect(ok.code, ok.out).toBe(0);
      const args = calledWith('claude')[0];
      expect(args).toContain('/evaluar-semana 2026-W42');
      expect(args.slice(-2)).toEqual(['--model', 'sonnet']);

      fs.writeFileSync(calls, '');
      expect(run('first', { FAKE_STATUS: '9' }).code).toBe(14);
      expect(calledWith('claude')).toHaveLength(0);
    });

    test('sin vault (11), sin claude (13) y git pull que falla (10)', () => {
      expect(
        run('first', { VAULT_PATH: path.join(tmp, 'no-existe') }).code,
      ).toBe(11);
      expect(
        run('first', { FAKE_STATUS: '1' }, [], {
          exe: path.join(tmp, 'no-existe.exe'),
          prefix: [],
        }).code,
      ).toBe(13);

      // sin -SkipPull, un directorio que no es un repo git no puede hacer pull --ff-only
      const r = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(root, 'scripts', 'run-weekly.ps1'),
          '-Mode',
          'first',
          '-RepoRoot',
          repo,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            VAULT_PATH: path.join(
              vaultRoot,
              '02-Proyectos',
              'SkillsPluginFinder',
            ),
          },
        },
      );
      expect(r.status).toBe(10);
      expect(logText()).toContain('no fue fast-forward');
    });
  },
);
