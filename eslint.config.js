import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Root-level probe scripts are listed in .gitignore as disposable diagnostic
    // output. They are not application source and nothing imports them, so they
    // must not be able to turn `npm run lint` red - a baseline that is red on
    // purpose is a baseline people learn to ignore.
    ignores: [
      'dist', 'node_modules', 'coverage',
      'fix_inspection.ts', 'verify_fix.ts', 'neon.ts', 'hello-world.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Node scripts run from the command line, so they need Node's globals.
    // Without this they report `process` and `console` as undefined, which is a
    // false positive rather than a real finding.
    files: ['scripts/**/*.{mjs,cjs}', 'tests/**/*.{mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    /**
     * The archived CommonJS diagnostic scripts in scripts/diagnostics/.
     *
     * They are CommonJS and run directly under Node, so they need the Node
     * globals, and `@typescript-eslint/no-require-imports` does not apply: that
     * rule exists to stop TypeScript modules mixing `require` into ESM, which
     * cannot happen in a `.cjs` file. Linting them as if they were browser
     * TypeScript produced hundreds of errors that were all configuration
     * artefacts - `console is not defined`, `require is not defined` - and no
     * real defect. `npm run lint` has to be trustworthy, because a red baseline
     * is what makes people ignore it.
     *
     * Nothing imports these; see scripts/diagnostics/README.md before running
     * anything in there.
     */
    files: ['scripts/diagnostics/**/*.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.commonjs } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)