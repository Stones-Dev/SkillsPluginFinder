#!/usr/bin/env node
import {
  closeDatabases,
  collect,
  collectBatch,
  pipelinePublishReport,
  pipelineSyncInterests,
  pipelineUpdateCatalog,
  prepareBatch,
} from '@spf/core';
import { Command } from 'commander';

const program = new Command();

program.name('spf').description('CLI for SkillsPluginFinder').version('1.0.0');

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
      console.error(
        `Error en collect: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program
  .command('prepare')
  .description('Prepare batch for evaluation')
  .option('-w, --week <week>', 'ISO week (YYYY-Www)')
  .action(async (options) => {
    try {
      if (!options.week) throw new Error('Week is required');
      console.log(`Preparing batch for week ${options.week}...`);
      await prepareBatch(options.week);
      closeDatabases();
      console.log('Batch prepared.');
    } catch (err) {
      console.error(
        `Error en prepare: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program
  .command('collect-batch')
  .description('Collect evaluation results from agent')
  .option('-w, --week <week>', 'ISO week (YYYY-Www)')
  .action(async (options) => {
    try {
      if (!options.week) throw new Error('Week is required');
      console.log('Collecting batch...');
      await collectBatch(options.week);
      console.log('Batch collected.');
    } catch (err) {
      console.error('Error in collect-batch:', err);
      process.exit(1);
    }
  });

program
  .command('publish')
  .description('Publish results to vault')
  .option('-w, --week <week>', 'ISO week (YYYY-Www)')
  .action(async (options) => {
    try {
      if (!options.week) throw new Error('Week is required');
      console.log('Publishing...');
      const results = await collectBatch(options.week);
      await pipelinePublishReport(options.week, results);
      await pipelineUpdateCatalog(results);
      console.log('Publish completed.');
    } catch (err) {
      console.error('Error in publish:', err);
      process.exit(1);
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
      console.error(
        `Error en interests sync: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  });

program.parse(process.argv);
