#!/usr/bin/env node
import {
  checkRateLimits,
  closeDatabases,
  collect,
  collectScorings,
  fetchRateLimits,
  formatPrepare,
  formatRateLimits,
  formatReviewList,
  isoWeek,
  pipelineSyncInterests,
  prepare,
  publish,
  reviewList,
  reviewPrepare,
} from '@spf/core';
import { Command, InvalidArgumentError } from 'commander';

const program = new Command();

program
  .name('spf')
  .description('SkillsPluginFinder: recoge, evalúa y publica hallazgos')
  .version('1.0.0');

/** Los errores esperados se muestran sin traza; el código de salida avisa al llamador. */
function fail(command: string, err: unknown): never {
  console.error(
    `Error en ${command}: ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
}

const weekOption = ['-w, --week <week>', 'Semana ISO (YYYY-Www)'] as const;

program
  .command('week')
  .description('Imprime la semana ISO de hoy (YYYY-Www, Europe/Madrid)')
  .action(() => {
    console.log(isoWeek(new Date()));
  });

program
  .command('collect')
  .description(
    'Mitad nube: recoge, filtra y enriquece candidatos en data/candidates/YYYY-Www.json',
  )
  .option('-s, --source <source>', 'Fuente a recoger (solo github-search)')
  .action(async (options) => {
    try {
      const { week, file, run, totalCandidates } = await collect({
        source: options.source,
        logger: (m) => console.log(m),
      });
      const s = run.stats;
      console.log(
        [
          `Semana ${week} · github-search`,
          `  ${s.queries} consultas → ${s.requests} peticiones de búsqueda (${s.cacheHits} de caché) → ${s.rawItems} resultados → ${s.uniqueRepos} repos únicos`,
          `  tras dedupe: ${s.afterDedupe} · tras reglas: ${s.afterRules} (${s.afterDedupe - s.afterRules} descartados)`,
          `  seleccionados: ${s.selected} · diferidos por el tope: ${s.deferred} · enriquecidos: ${s.enriched}`,
          `  enrich: ${s.enrichRequests ?? 0} peticiones (${s.enrichCacheHits ?? 0} de caché)`,
          `  errores por fuente: ${run.errorsBySource.length}`,
          `→ ${file} (${totalCandidates} candidatos)`,
        ].join('\n'),
      );
      for (const e of run.errorsBySource) {
        console.log(`  error: ${e.query ?? e.source}: ${e.message}`);
      }
      closeDatabases();
    } catch (err) {
      fail('collect', err);
    }
  });

/** Entero positivo de una opción de la CLI. */
function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError('debe ser un entero positivo');
  }
  return n;
}

program
  .command('rate-limit')
  .description(
    'Consulta los límites de la API de GitHub del GITHUB_TOKEN (GET /rate_limit, no consume cuota); con --min-* falla si no alcanzan',
  )
  .option(
    '--min-core <n>',
    'Peticiones `core` que deben quedar (el enrich gasta unas 250)',
    positiveInt,
  )
  .option(
    '--min-search <n>',
    'Límite por minuto de `search` (30 con token, 10 sin él)',
    positiveInt,
  )
  .action(async (options) => {
    try {
      const limits = await fetchRateLimits(process.env.GITHUB_TOKEN);
      console.log(formatRateLimits(limits).join('\n'));
      const problems = checkRateLimits(limits, {
        core: options.minCore,
        search: options.minSearch,
      });
      if (problems.length > 0) {
        for (const p of problems) console.error(`  ✗ ${p}`);
        process.exit(1);
      }
      if (options.minCore !== undefined || options.minSearch !== undefined) {
        console.log('  ✓ la cuota alcanza para una recogida');
      }
    } catch (err) {
      fail('rate-limit', err);
    }
  });

program
  .command('prepare')
  .description(
    'Mitad local: genera data/batches/<semana>/batch.md para el evaluador',
  )
  .requiredOption(...weekOption)
  .action(async (options) => {
    try {
      const result = await prepare(options.week);
      const categories = Object.entries(result.categories)
        .map(([id, n]) => `${id}: ${n}`)
        .join(' · ');
      console.log(
        [
          `Batch ${options.week}: ${result.candidates} fichas (${categories || 'ninguna'})`,
          `→ ${result.file}`,
          ...(result.scoringExists
            ? ['  ya existe scoring.json de esta semana; no se ha tocado']
            : []),
        ].join('\n'),
      );
    } catch (err) {
      fail('prepare', err);
    }
  });

program
  .command('collect-batch')
  .description(
    'Valida scoring.json del evaluador (cobertura, categorías, sesgo) y guarda los scorings',
  )
  .requiredOption(...weekOption)
  .action(async (options) => {
    try {
      const { summary } = await collectScorings(options.week);
      const distribution = Object.entries(summary.distribution)
        .map(([score, n]) => `${score}:${n}`)
        .join(' ');
      console.log(
        [
          `Batch ${options.week} válido: ${summary.total} fichas guardadas`,
          `  distribución (score:fichas) ${distribution}`,
          `  ≥ ${summary.umbral} (irán al informe): ${summary.aboveThreshold} · ≥ 8: ${summary.high}`,
        ].join('\n'),
      );
      closeDatabases();
    } catch (err) {
      fail('collect-batch', err);
    }
  });

program
  .command('publish')
  .description(
    'Escribe Informes/<semana>.md y añade filas `candidato` a Catalogo.md en el vault',
  )
  .requiredOption(...weekOption)
  .option('--force', 'Sobrescribir un informe ya marcado revisado: true')
  .action(async (options) => {
    try {
      const r = await publish(options.week, { force: options.force });
      closeDatabases();
      console.log(
        [
          `Informe ${options.week}: ${r.published} hallazgos ≥ umbral de ${r.evaluated} evaluados`,
          `→ ${r.reportFile}`,
          `Catálogo: +${r.catalogAdded} filas (candidato)${r.catalogSkipped > 0 ? `, ${r.catalogSkipped} ya estaban` : ''}`,
        ].join('\n'),
      );
    } catch (err) {
      fail('publish', err);
    }
  });

program
  .command('review')
  .description(
    'Revisión de los hallazgos en estado candidato (solo lectura de lo ajeno)',
  )
  .option(
    '--list',
    'Lista las filas candidato de Catalogo.md con su categoría, score, proyecto afectado y URL',
  )
  .option(
    '--prepare [id]',
    'Clon superficial (sin instalar ni ejecutar nada) e inventario de un hallazgo (github:owner/repo) o, con --week, de todos los de esa semana',
  )
  .option('-w, --week <week>', 'Semana ISO (YYYY-Www) para --prepare')
  .action(async (options) => {
    try {
      const modes = [options.list, options.prepare].filter(Boolean).length;
      if (modes !== 1) {
        throw new Error('indica una sola acción: --list o --prepare');
      }
      if (options.list) {
        console.log(formatReviewList(await reviewList()).join('\n'));
        return;
      }
      const id =
        typeof options.prepare === 'string' ? options.prepare : undefined;
      if (!id && !options.week) {
        throw new Error(
          '--prepare necesita un id (github:owner/repo) o --week',
        );
      }
      const outcomes = await reviewPrepare({
        ids: id ? [id] : undefined,
        week: options.week,
      });
      console.log(formatPrepare(outcomes).join('\n'));
      if (outcomes.some((o) => !o.ok)) process.exit(1);
    } catch (err) {
      fail('review', err);
    }
  });

const interests = program
  .command('interests')
  .description('Intereses y catálogo del vault');

interests
  .command('sync')
  .description(
    'Sincroniza Intereses.md ↔ interests.yaml y exporta Catalogo.md a catalog.json',
  )
  .action(async () => {
    const messages = {
      created: 'interests.yaml creado desde Intereses.md',
      unchanged: 'interests.yaml ya estaba al día',
      'vault-to-repo': 'interests.yaml actualizado desde Intereses.md',
      'repo-to-vault': 'Intereses.md actualizado desde interests.yaml',
    };
    try {
      const result = await pipelineSyncInterests();
      console.log(messages[result.interests]);
      console.log(
        `catalog.json: ${result.catalogEntries} entradas${result.catalogChanged ? ' (actualizado)' : ' (sin cambios)'}`,
      );
    } catch (err) {
      fail('interests sync', err);
    }
  });

program.parse(process.argv);
