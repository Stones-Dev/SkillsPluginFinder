import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `data/review/` guarda clones de repos ajenos (spf review --prepare): sus
    // ficheros de test no deben ejecutarse nunca. Las fixtures tampoco son tests.
    exclude: [...configDefaults.exclude, 'data/**', '**/tests/fixtures/**'],
  },
});
