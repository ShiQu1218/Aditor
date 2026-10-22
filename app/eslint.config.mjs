import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// Only hook rules: typecheck already covers the rest, and these catch bugs tsc cannot.
export default tseslint.config({ ignores: ['out/**'] }, {
  files: ['src/renderer/**/*.{ts,tsx}'],
  languageOptions: { parser: tseslint.parser },
  plugins: { 'react-hooks': reactHooks },
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
  },
})
