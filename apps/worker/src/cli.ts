#!/usr/bin/env node
import { Command } from 'commander';
import { runPipeline, prepareBatch, collectBatch, pipelinePublishReport, pipelineUpdateCatalog, pipelineSyncInterests } from '@spf/core';

const program = new Command();

program
  .name('spf')
  .description('CLI for SkillsPluginFinder')
  .version('1.0.0');

program
  .command('collect')
  .description('Collect candidates from sources')
  .action(async () => {
    try {
      console.log('Running collect pipeline...');
      await runPipeline('collect');
      console.log('Collection completed.');
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

program
  .command('interests sync')
  .description('Sync interests between vault and repo')
  .action(async () => {
    try {
      console.log('Syncing interests...');
      await pipelineSyncInterests();
      console.log('Sync completed.');
    } catch (err) {
      console.error('Error syncing interests:', err);
      process.exit(1);
    }
  });

program.parse(process.argv);
