#!/usr/bin/env node
import {
  collectBatch,
  pipelinePublishReport,
  pipelineSyncInterests,
  pipelineUpdateCatalog,
  prepareBatch,
  runPipeline,
} from '@spf/core';
import { Command } from 'commander';

const program = new Command();

program.name('spf').description('CLI for SkillsPluginFinder').version('1.0.0');

program
  .command('collect')
  .description('Collect candidates from sources')
  .option('-s, --source <source>', 'Source to collect from')
  .action(async (options) => {
    try {
      console.log('Running collect pipeline...');
      const collected = await runPipeline('collect', options.source);
      console.log(`Collected ${collected.length} candidates after filtering.`);
    } catch (err) {
      console.error('Error in collect:', err);
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
      console.log('Batch prepared.');
    } catch (err) {
      console.error('Error in prepare:', err);
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
