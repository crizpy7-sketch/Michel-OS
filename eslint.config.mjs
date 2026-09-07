import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Correctness baseline; no formatting preset, autofixes, or inline suppressions.
// TypeScript's official recommended preset replaces incompatible JS rules.
export default defineConfig(
  { ignores: ['node_modules/**', '.git/**', '.swarm/**'] },
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2023, globals: globals.node },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['public/**/*.{js,mjs,jsx}'],
    languageOptions: {
      globals: { ...Object.fromEntries(Object.keys(globals.node).map(name => [name, 'off'])), ...globals.browser },
    },
  },
  {
    // These two maintained Playwright scripts contain Node code plus browser
    // callbacks passed to page.evaluate; both execution environments apply.
    files: ['docs/design/checks/crawl-controls.mjs', 'docs/design/checks/refresh-on-return.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
