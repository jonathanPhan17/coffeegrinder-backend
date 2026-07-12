// Lint = the third leg of the gate (typecheck + lint + tests). Type-checked rules catch
// legal-but-wrong code tsc accepts — the headline one here is no-floating-promises: an
// un-awaited promise in a Lambda handler compiles fine and silently drops its error when
// the invocation freezes.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['cdk.out/'] },
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Async-without-await is the contract here, not a bug: Fastify route plugins and
      // handlers must return promises, and JobSource.fetch implementations conform to a
      // promise-returning interface. no-floating-promises still guards the real hazard.
      '@typescript-eslint/require-await': 'off',
      // `const { omitted, ...rest } = obj` is the idiomatic omit-a-key destructure.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // CDK assertion tests walk raw CloudFormation JSON — findResources() returns untyped
    // objects, so member access on `any` is the mechanism of the test, not an accident.
    files: ['lib/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
