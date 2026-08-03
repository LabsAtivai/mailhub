// @ts-check
const tseslint = require('typescript-eslint')

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // any explícito é permitido em fronteiras (payload de erro externo etc);
      // o que importa pro gate de CI é pegar bug real, não estilo.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    }
  }
)
