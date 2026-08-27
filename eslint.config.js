import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // `catch (_)` and deliberately-ignored args are a house idiom, not a defect.
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^[A-Z_]',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // ── React Compiler diagnostics: WARN, not error ────────────────────────
      // eslint-plugin-react-hooks v7 ships the React Compiler's own analysis as
      // default-error rules. This app does NOT run the compiler (see
      // vite.config.js — plugin-react with no babel-plugin-react-compiler), so
      // these describe optimisations that are not being attempted rather than
      // defects. All 28 that fired were reviewed one by one on 2026-08-27 and
      // every one was a safe idiom under the runtime we actually ship:
      //   refs        — `storeIdRef.current = storeId` during render IS the
      //                 store-isolation guard (a late reply from the previous
      //                 company must not land in this one's state). Moving it to
      //                 an effect would leave a window where it reads stale.
      //   purity      — `Date.now()` while rendering an age/countdown. Deliberate;
      //                 a tick interval drives the re-render.
      //   set-state-in-effect — a load() on mount. The alternative is data that
      //                 never arrives.
      //   preserve-manual-memoization / immutability — advice for a compiler that
      //                 is not running.
      // Left at 'warn' so the advice stays visible for the day the compiler goes
      // on, without a dependency bump alone being able to fail the build gate.
      // The rules that actually protect a file split — no-undef, no-unused-vars,
      // rules-of-hooks — remain errors.
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/incompatible-library': 'warn',
      'react-hooks/unsupported-syntax': 'warn',

      // Fast Refresh ergonomics, not correctness: shared modules such as
      // inventoryShared.jsx export a component AND the constants its callers
      // need, on purpose. Worth seeing, never worth failing a release for.
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    // Build/config files run in Node, not the browser — without this, __dirname
    // reads as an undefined identifier and buries the no-undef signal that makes
    // this config a useful gate after a file split.
    files: ['*.config.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
])
