import js from '@eslint/js';
import babelParser from '@babel/eslint-parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        babelOptions: {
          babelrc: false,
          configFile: false,
          presets: ['@babel/preset-typescript'],
        },
        requireConfigFile: false,
      },
    },
    rules: {
      // Babel parses TypeScript syntax without TypeScript's scope analysis; tsc
      // remains the authoritative type checker for .ts files.
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
