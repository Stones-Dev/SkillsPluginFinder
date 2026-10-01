import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const runner = path.join(root, 'scripts', 'run-weekly.ps1');
const isWindows = process.platform === 'win32';

// El `claude` y el `pnpm` de estas pruebas se escriben en un directorio temporal en tiempo
// de ejecución: dobles de herramientas externas, no ficheros del repo. El `pnpm` de pega
// responde a `spf status` como el real: «sin recogida» si no existe data/candidates/<semana>.json
// en el repo de prueba (código 2), y si no, según los pasos que diga FAKE_DONE (1 incompleta, 0 completa).
const FAKE_PNPM = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['pnpm', ...args]) + '\\n');
if (args.includes('week')) { console.log(process.env.FAKE_WEEK || '2026-W41'); process.exit(0); }
if (args.includes('status')) {
  const week = args[args.indexOf('--week') + 1];
  const collected = fs.existsSync(path.join(process.cwd(), 'data', 'candidates', week + '.json'));
  const done = new Set((process.env.FAKE_DONE || '').split(',').filter(Boolean));
  const ids = ['recogida', 'claude', 'antigravity', 'cruce', 'publicacion', 'revision'];
  const steps = ids.map((id) => ({ id, name: id, done: id === 'recogida' ? collected : done.has(id), detail: '' }));
  const complete = steps.every((s) => s.done);
  console.log(args.includes('--json') ? JSON.stringify({ week, steps, complete, nothingToEvaluate: !collected }) : 'estado');
  process.exit(process.env.FAKE_FORCE_CODE ? Number(process.env.FAKE_FORCE_CODE) : !collected ? 2 : complete ? 0 : 1);
}
process.exit(0);
`;
const FAKE_CLAUDE = `
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['claude', ...process.argv.slice(2)]) + '\\n');
if (process.env.FAKE_CLAUDE_SLEEP) { setTimeout(() => {}, 60000); return; }
console.log('flujo simulado');
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
`;

const EVALUATION = 'claude,antigravity,cruce,publicacion';
const ALL = `${EVALUATION},revision`;
/** Después del cron de Actions del lunes 2026-10-05 (05:00 UTC) y de la hora de la guarda previa (06:00 UTC). */
const AFTER_CRON = '2026-10-05T12:00:00Z';

describe.skipIf(!isWindows)(
  'scripts/run-weekly.ps1 con claude y pnpm de prueba',
  () => {
    let tmp: string;
    let repo: string;
    let vaultRoot: string;
    let calls: string;
    let lockCounter = 0;
    let lockName: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-weekly-'));
      repo = path.join(tmp, 'repo');
      vaultRoot = path.join(tmp, 'Cerebro');
      calls = path.join(tmp, 'calls.jsonl');
      lockName = `Local\\SPFTEST-${process.pid}-${lockCounter++}`;
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

    /** La recogida de esa semana (solo importa que exista el fichero). */
    const collect = (week = '2026-W41') => {
      const dir = path.join(repo, 'data', 'candidates');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${week}.json`), '{}');
    };

    const baseArgs = (mode: string, nowUtc: string) => [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      runner,
      '-Mode',
      mode,
      '-RepoRoot',
      repo,
      '-SkipPull',
      '-NowUtc',
      nowUtc,
      '-LockName',
      lockName,
    ];
    const toolArgs = (claude: { exe: string; prefix: string[] }) => [
      '-Claude',
      claude.exe,
      ...(claude.prefix.length > 0
        ? ['-ClaudePrefixArgs', ...claude.prefix]
        : []),
      '-Pnpm',
      process.execPath,
      '-PnpmPrefixArgs',
      path.join(tmp, 'fake-pnpm.js'),
    ];
    const environment = (env: Record<string, string>) => ({
      ...process.env,
      VAULT_PATH: path.join(vaultRoot, '02-Proyectos', 'SkillsPluginFinder'),
      FAKE_CALLS: calls,
      ...env,
    });

    function run(
      mode: string,
      env: Record<string, string> = {},
      extra: string[] = [],
      options: {
        nowUtc?: string;
        claude?: { exe: string; prefix: string[] };
      } = {},
    ) {
      const claude = options.claude ?? {
        exe: process.execPath,
        prefix: [path.join(tmp, 'fake-claude.js')],
      };
      const r = spawnSync(
        'powershell.exe',
        [
          ...baseArgs(mode, options.nowUtc ?? AFTER_CRON),
          ...toolArgs(claude),
          ...extra,
        ],
        { encoding: 'utf8', env: environment(env), timeout: 120_000 },
      );
      return { code: r.status, out: r.stdout + r.stderr };
    }

    const callsOf = (who: string) =>
      fs
        .readFileSync(calls, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
        .filter((c) => c[0] === who);
    const claudePrompts = () =>
      callsOf('claude').map((c) => c[c.indexOf('-p') + 1]);
    const logText = () => {
      const dir = path.join(repo, 'data', 'logs');
      return fs
        .readdirSync(dir)
        .filter((f) => /^weekly-.*\d\.log$/.test(f))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n');
    };

    describe('semana sin recogida', () => {
      test('después del cron: first sale con 12 (la nube no recogió) y retry con 0; ninguno lanza claude', () => {
        const first = run('first');
        const retry = run('retry');

        expect(first.code, first.out).toBe(12);
        expect(retry.code, retry.out).toBe(0);
        expect(callsOf('claude')).toHaveLength(0);
        expect(logText()).toContain('nada que evaluar todavia');
        expect(logText()).toContain('sigue sin haber recogida de 2026-W41');
      });

      test('antes del lunes 06:00 UTC y sin data/candidates: «aún no hay recogida», sin ni mirar el estado', () => {
        const r = run('first', {}, [], { nowUtc: '2026-10-05T05:59:00Z' });

        expect(r.code, r.out).toBe(0);
        expect(logText()).toContain('aun no hay recogida de 2026-W41');
        expect(logText()).toContain(
          'antes del lunes 06:00 UTC (2026-10-05 06:00 UTC)',
        );
        expect(callsOf('pnpm').map((c) => c[3])).toEqual(['week']); // solo preguntó la semana
        expect(callsOf('claude')).toHaveLength(0);
      });

      test('el domingo por la noche (ya es la W41 en Madrid, el cron aún no ha corrido) tampoco pisa la semana', () => {
        const r = run('first', {}, [], { nowUtc: '2026-10-04T22:30:00Z' });

        expect(r.code, r.out).toBe(0);
        expect(logText()).toContain('aun no hay recogida de 2026-W41');
      });

      test('a las 06:00 UTC en punto ya no es «antes del cron»: pasa a mirar el estado (12 sin recogida)', () => {
        const r = run('first', {}, [], { nowUtc: '2026-10-05T06:00:00Z' });

        expect(r.code, r.out).toBe(12);
        expect(callsOf('pnpm').some((c) => c.includes('status'))).toBe(true);
      });

      test('antes del cron pero con la recogida ya hecha (p. ej. un run manual) sí sigue', () => {
        collect();

        const r = run('first', { FAKE_DONE: '' }, [], {
          nowUtc: '2026-10-04T23:00:00Z',
        });

        expect(r.code, r.out).toBe(0);
        expect(claudePrompts()).toEqual(['/evaluar-semana 2026-W41']);
      });

      test('el cron cuenta desde el lunes de la semana ISO: la W01 de 2026 empieza el 2025-12-29', () => {
        const before = run('first', { FAKE_WEEK: '2026-W01' }, [], {
          nowUtc: '2025-12-29T05:59:00Z',
        });
        expect(before.code, before.out).toBe(0);
        expect(logText()).toContain('aun no hay recogida de 2026-W01');
        expect(logText()).toContain('(2025-12-29 06:00 UTC)');

        const after = run('first', { FAKE_WEEK: '2026-W01' }, [], {
          nowUtc: '2026-01-01T10:00:00Z',
        });
        expect(after.code, after.out).toBe(12);
      });
    });

    describe('semana con recogida pero sin evaluar', () => {
      test('first lanza /evaluar-semana de esa semana, con la allowlist y el vault', () => {
        collect();

        const r = run('first', { FAKE_DONE: '' });

        expect(r.code, r.out).toBe(0);
        const [claude] = callsOf('claude');
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
        expect(log).toContain('lanzo:');
        expect(log).toContain('RESULTADO (0)');
        const files = fs.readdirSync(path.join(repo, 'data', 'logs'));
        const out = files.find((f) => f.endsWith('.claude.out.txt')) as string;
        expect(
          fs.readFileSync(path.join(repo, 'data', 'logs', out), 'utf8'),
        ).toContain('flujo simulado');
      });

      test('con la evaluación a medias (Claude Code validada, lo demás no) también /evaluar-semana', () => {
        collect();

        run('first', { FAKE_DONE: 'claude' });

        expect(claudePrompts()).toEqual(['/evaluar-semana 2026-W41']);
      });

      test('sea el día que sea: no hay guarda por día', () => {
        collect();
        const days = [
          '2026-10-05T12:00:00Z', // lunes
          '2026-10-06T09:00:00Z', // martes
          '2026-10-08T09:00:00Z', // jueves
          '2026-10-11T09:00:00Z', // domingo
        ];
        for (const nowUtc of days) {
          fs.writeFileSync(calls, '');
          const r = run('first', { FAKE_DONE: '' }, [], { nowUtc });
          expect(r.code, `${nowUtc}: ${r.out}`).toBe(0);
          expect(claudePrompts(), nowUtc).toEqual(['/evaluar-semana 2026-W41']);
        }
      });
    });

    describe('semana evaluada', () => {
      test('completa: sale con «semana 2026-W41 ya evaluada» y no lanza nada, en first y en retry', () => {
        collect();

        const first = run('first', { FAKE_DONE: ALL });
        const retry = run('retry', { FAKE_DONE: ALL });

        expect(first.code, first.out).toBe(0);
        expect(retry.code, retry.out).toBe(0);
        expect(callsOf('claude')).toHaveLength(0);
        expect(logText()).toContain(
          'semana 2026-W41 ya evaluada: nada que hacer',
        );
      });

      test('evaluada y publicada pero con candidatos sin revisar: lanza solo /revisar-hallazgos --week, no reevalúa', () => {
        collect();

        const r = run('first', { FAKE_DONE: EVALUATION });

        expect(r.code, r.out).toBe(0);
        expect(claudePrompts()).toEqual(['/revisar-hallazgos --week 2026-W41']);
      });

      test('con la publicación pendiente (publicada antes del cruce) vuelve al flujo completo', () => {
        collect();

        run('first', { FAKE_DONE: 'claude,antigravity,cruce' });

        expect(claudePrompts()).toEqual(['/evaluar-semana 2026-W41']);
      });
    });

    describe('retry: solo reintenta lo que first dejó sin cerrar', () => {
      test('si first nunca lanzó el flujo (no hay log suyo con «lanzo:») no hay nada que reintentar', () => {
        collect();

        const r = run('retry', { FAKE_DONE: 'claude' });

        expect(r.code, r.out).toBe(0);
        expect(callsOf('claude')).toHaveLength(0);
        expect(logText()).toContain(
          'first no llego a lanzar el flujo de 2026-W41',
        );
      });

      test('si first lanzó el flujo y la semana sigue sin cerrar, retry lo relanza (y retoma por lo que falte)', () => {
        collect();
        run('first', { FAKE_DONE: 'claude', FAKE_CLAUDE_EXIT: '7' }); // first murió a medias
        fs.writeFileSync(calls, '');

        const r = run('retry', { FAKE_DONE: 'claude,antigravity' });

        expect(r.code, r.out).toBe(0);
        expect(claudePrompts()).toEqual(['/evaluar-semana 2026-W41']);
      });

      test('el log de first de OTRA semana no cuenta', () => {
        collect();
        collect('2026-W40');
        run('first', { FAKE_WEEK: '2026-W40', FAKE_DONE: '' });
        fs.writeFileSync(calls, '');

        const r = run('retry', { FAKE_WEEK: '2026-W41', FAKE_DONE: '' });

        expect(r.code, r.out).toBe(0);
        expect(callsOf('claude')).toHaveLength(0);
      });

      test('si first dejó la semana cerrada, retry no hace nada', () => {
        collect();
        run('first', { FAKE_DONE: '' });
        fs.writeFileSync(calls, '');

        const r = run('retry', { FAKE_DONE: ALL });

        expect(r.code, r.out).toBe(0);
        expect(callsOf('claude')).toHaveLength(0);
      });
    });

    test('una sola ejecución a la vez: con otra en curso (mutex tomado) no hace nada', async () => {
      collect();
      const holder = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$m = New-Object System.Threading.Mutex($false, '${lockName}'); if ($m.WaitOne(0)) { 'HELD'; Start-Sleep -Seconds 60 }`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          holder.stdout.on(
            'data',
            (d: Buffer) => d.toString().includes('HELD') && resolve(),
          );
          holder.on('error', reject);
          setTimeout(() => reject(new Error('el mutex no se tomó')), 20_000);
        });

        const r = run('first', { FAKE_DONE: '' });

        expect(r.code, r.out).toBe(0);
        expect(logText()).toContain(
          'otra ejecucion del flujo semanal esta en curso',
        );
        expect(callsOf('claude')).toHaveLength(0);
        expect(callsOf('pnpm')).toHaveLength(0);
      } finally {
        holder.kill();
      }

      // y liberado el mutex, se ejecuta con normalidad
      await new Promise((r) => setTimeout(r, 500));
      const after = run('first', { FAKE_DONE: '' });
      expect(after.code, after.out).toBe(0);
      expect(callsOf('claude')).toHaveLength(1);
    });

    test('si claude sale con error (4) se avisa y se mira el estado final', () => {
      collect();

      const r = run('first', { FAKE_DONE: '', FAKE_CLAUDE_EXIT: '7' });

      expect(r.code, r.out).toBe(4);
      expect(logText()).toContain('claude salio con codigo 7');
      expect(logText()).toContain('spf status final');
    });

    test('si claude no termina a tiempo (3) se mata el proceso', () => {
      collect();

      const r = run('first', { FAKE_DONE: '', FAKE_CLAUDE_SLEEP: '1' }, [
        '-TimeoutSeconds',
        '2',
      ]);

      expect(r.code, r.out).toBe(3);
      expect(logText()).toContain('proceso matado');
    });

    test('--Model y --Week se pasan; y un código de status inesperado no lanza nada (14)', () => {
      collect('2026-W42');

      const ok = run('first', { FAKE_DONE: '' }, [
        '-Week',
        '2026-W42',
        '-Model',
        'sonnet',
      ]);
      expect(ok.code, ok.out).toBe(0);
      const args = callsOf('claude')[0];
      expect(args).toContain('/evaluar-semana 2026-W42');
      expect(args.slice(-2)).toEqual(['--model', 'sonnet']);

      fs.writeFileSync(calls, '');
      expect(
        run('first', { FAKE_FORCE_CODE: '9' }, ['-Week', '2026-W42']).code,
      ).toBe(14);
      expect(callsOf('claude')).toHaveLength(0);
    });

    test('sin vault (11), sin claude (13) y git pull que falla (10)', () => {
      collect();
      expect(
        run('first', { VAULT_PATH: path.join(tmp, 'no-existe') }).code,
      ).toBe(11);
      expect(
        run('first', { FAKE_DONE: '' }, [], {
          claude: { exe: path.join(tmp, 'no-existe.exe'), prefix: [] },
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
          runner,
          '-Mode',
          'first',
          '-RepoRoot',
          repo,
          '-LockName',
          lockName,
        ],
        { encoding: 'utf8', env: environment({}) },
      );
      expect(r.status).toBe(10);
      expect(logText()).toContain('no fue fast-forward');
    });
  },
);
