module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
    worker: true
  },
  extends: [
    'eslint:recommended'
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  plugins: [
    '@typescript-eslint'
  ],
  rules: {
    'no-unused-vars': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    'prefer-const': 'error',
    'no-var': 'error'
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    '*.js'
  ],
  globals: {
    'KVNamespace': 'readonly',
    'fetch': 'readonly',
    'AbortSignal': 'readonly',
    'crypto': 'readonly',
    'CompressionStream': 'readonly',
    'DecompressionStream': 'readonly',
    'URLSearchParams': 'readonly',
    'DOMParser': 'readonly'
  }
};