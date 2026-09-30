#!/usr/bin/env node
import {
  closeDatabases,
  collect,
  collectScorings,
  pipelineSyncInterests,
  prepare,
} from '@spf/core';
import { Command } from 'commander';

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
          `  ${s.queries} consultas → ${s.requests} peticiones (${s.cacheHits} de caché) → ${s.rawItems} resultados → ${s.uniqueRepos} repos únicos`,
          `  tras dedupe: ${s.afterDedupe} · tras reglas: ${s.afterRules} (${s.afterDedupe - s.afterRules} descartados)`,
          `  seleccionados: ${s.selected} · diferidos por el tope: ${s.deferred} · enriquecidos: ${s.enriched}`,
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
  .description('Escribe el informe y las filas del catálogo en el vault')
  .requiredOption(...weekOption)
  .action(() => {
    fail('publish', 'aún no implementado');
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
