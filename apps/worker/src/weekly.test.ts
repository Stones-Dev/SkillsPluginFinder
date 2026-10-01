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
  // la hora va como 09h00 en el NOMBRE: con ':' Register-ScheduledTask falla con 0x80070057
  expect(scheduler).toContain('"$TaskPrefix - evaluar semana (lunes 09h00)"');
  expect(scheduler).toContain("Mode = 'first'; At = '09:00'");
  expect(scheduler).toContain('"$TaskPrefix - reintento (lunes 12h00)"');
  expect(scheduler).toContain("Mode = 'retry'; At = '12:00'");
  expect(scheduler).toContain("$invalidInName = '[\\\\/:*?\"<>|]'");
  // falla de verdad: -ErrorAction Stop, comprobación con Get-ScheduledTask/Info y salida 1
  expect(scheduler).toContain('-Force -ErrorAction Stop');
  expect(scheduler).toContain('Get-ScheduledTask -TaskName $t.Name');
  expect(scheduler).toContain('Get-ScheduledTaskInfo');
  expect(scheduler).toContain('exit 1');
  expect(scheduler).toContain('Registrada y comprobada');
  expect(scheduler).not.toMatch(/Write-Host "Registrada: /);
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

test('run-weekly.ps1 lanza claude -p con la allowlist, el vault y sin pushear', () => {
  expect(runner).toContain(
    '"/revisar-hallazgos --week $Week" } else { "/evaluar-semana $Week"',
  );
  expect(runner).toContain("'-p', $workflow,");
  expect(runner).toContain("'--settings', $settings");
  expect(runner).toContain('settings.weekly.json');
  expect(runner).toContain("'--add-dir', $vaultRoot");
  expect(runner).toContain("'--no-session-persistence'");
  expect(runner).toContain("'pull', '--ff-only'");
  expect(runner).not.toMatch(/'push'|dangerously-skip-permissions/);
  // la guarda es por estado de la semana ISO (spf status --json), no por día
  expect(runner).toContain("'status', '--week', $Week, '--json'");
  expect(runner).toContain('data\\logs');
  expect(runner).not.toMatch(/DayOfWeek -ne 'Monday'|AllowAnyDay/);
  // orden: un solo flujo a la vez → vault → git pull → semana → previa al cron → estado → reintento → claude
  const order = [
    'System.Threading.Mutex',
    '$vaultPath = ',
    "'pull', '--ff-only'",
    "'spf', 'week'",
    'Get-IsoWeekMondayUtc $Week',
    "'status', '--week', $Week, '--json'",
    "if ($Mode -eq 'retry')",
    'Start-Process',
  ].map((needle) => runner.indexOf(needle, runner.indexOf('Write-Log "modo')));
  expect(order.every((p) => p > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // previa al cron de Actions: antes del lunes 06:00 UTC de la semana y sin recogida
  expect(runner).toContain('.AddHours(6)');
  expect(runner).toContain('data\\candidates\\$Week.json');
  // el reintento solo actúa si first lanzó el flujo (lo busca en sus logs)
  expect(runner).toContain("'weekly-first-*.log'");
  expect(runner).toContain("Contains('lanzo:')");
});

// Pruebas REALES del registrador: crean tareas con un prefijo de prueba en el Programador de tareas
// del usuario (sin administrador) y las eliminan siempre al terminar.
describe.skipIf(!isWindows)(
  'scripts/schedule-windows.ps1 contra el Programador de tareas',
  () => {
    const schedule = path.join(root, 'scripts', 'schedule-windows.ps1');
    const prefix = `SPFTEST${process.pid}`;
    const powershell = (command: string) =>
      spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
        {
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
    const listTasks = () =>
      powershell(
        `Get-ScheduledTask -TaskName '${prefix}*' -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName }`,
      )
        .stdout.split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const runSchedule = (...args: string[]) =>
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          schedule,
          '-TaskPrefix',
          prefix,
          ...args,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
    afterEach(() => {
      runSchedule('-Unregister');
    });

    test('registra las dos tareas, comprueba que existen y que el próximo lanzamiento es un lunes a la hora, y luego las elimina', () => {
      const r = runSchedule();

      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(
        /Registrada y comprobada: .* - evaluar semana \(lunes 09h00\).*proximo lanzamiento \d{4}-\d{2}-\d{2} 09:00/,
      );
      expect(r.stdout).toMatch(
        /Registrada y comprobada: .* - reintento \(lunes 12h00\).*proximo lanzamiento \d{4}-\d{2}-\d{2} 12:00/,
      );
      expect(listTasks().sort()).toEqual([
        `${prefix} - evaluar semana (lunes 09h00)`,
        `${prefix} - reintento (lunes 12h00)`,
      ]);

      // las dos son lunes de verdad, y la acción lanza el runner con su modo
      const info = powershell(
        `Get-ScheduledTask -TaskName '${prefix}*' | ForEach-Object { $i = Get-ScheduledTaskInfo -TaskName $_.TaskName; '{0}|{1}|{2}|{3}' -f $_.TaskName, $i.NextRunTime.DayOfWeek, $i.NextRunTime.ToString('HH:mm'), $_.Actions[0].Arguments }`,
      ).stdout;
      expect(info).toContain('|Monday|09:00|');
      expect(info).toContain('|Monday|12:00|');
      expect(info).toContain('run-weekly.ps1" -Mode first');
      expect(info).toContain('run-weekly.ps1" -Mode retry');

      const removed = runSchedule('-Unregister');
      expect(removed.status, removed.stdout + removed.stderr).toBe(0);
      expect(removed.stdout).toContain('Eliminada y comprobada');
      expect(listTasks()).toEqual([]);
    });

    test('registrar dos veces es idempotente (-Force): no duplica ni falla', () => {
      expect(runSchedule().status).toBe(0);
      const again = runSchedule();

      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(listTasks()).toHaveLength(2);
    });

    test('-WhatIf no registra nada y lo dice', () => {
      const r = runSchedule('-WhatIf');

      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('(-WhatIf: no se ha registrado nada)');
      expect(r.stdout).not.toContain('Registrada y comprobada');
      expect(listTasks()).toEqual([]);
    });

    test('falla de verdad (código 1, por stderr y sin "Registrada") con un prefijo que el Programador no admite, como los dos puntos', () => {
      const r = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          schedule,
          '-TaskPrefix',
          'SPFTEST:colon',
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );

      expect(r.status).toBe(1);
      expect(r.stderr).toContain('ERROR:');
      expect(r.stderr).toContain('caracter no permitido');
      expect(r.stdout).not.toContain('Registrada');
    });

    test('falla de verdad si Register-ScheduledTask rechaza la tarea (regresión del 0x80070057 con "09:00" en el nombre)', () => {
      // Se fuerza el mismo error que daba el nombre con ':' llamando a Register-ScheduledTask directamente.
      const r = powershell(
        `$a = New-ScheduledTaskAction -Execute 'powershell.exe'; $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '09:00'; try { Register-ScheduledTask -TaskName '${prefix} - x (lunes 09:00)' -Action $a -Trigger $t -ErrorAction Stop | Out-Null; 'REGISTRO_OK' } catch { 'FALLA: ' + $_.Exception.Message }`,
      );

      expect(r.stdout).toContain('FALLA:');
      expect(r.stdout).not.toContain('REGISTRO_OK');
    });
  },
);

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
