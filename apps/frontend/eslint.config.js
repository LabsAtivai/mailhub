// @ts-check
const tseslint = require('typescript-eslint')
const pluginVue = require('eslint-plugin-vue')

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },
  ...tseslint.configs.recommended,
  // "essential" pega bug real (v-for sem :key, side effect em computed etc);
  // "recommended" também cobra formatação (indentação, ordem de atributos) que
  // não bate com o estilo já usado no projeto — trocar geraria um diff gigante
  // e sem relação com nenhuma mudança de comportamento.
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
    }
  }
)
