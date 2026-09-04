import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";

export default defineConfig([
  js.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier,
  globalIgnores([
    "demo/",
    "src/MarchingCubes.ts",
    "src/NaiveSurfaceNets.js",
    "docs/",
    "es/",
    "babel.config.js",
    "eslint.config.js",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      }
    },
    rules: {
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "@typescript-eslint/no-wrapper-object-types": "warn",
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "default",
          format: ["camelCase", "PascalCase"]
        },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE"]
        },
        {
          selector: "property",
          format: ["camelCase", "UPPER_CASE"]
        },
        {
          selector: "typeLike",
          format: ["PascalCase"]
        },
        {
          selector: "enumMember",
          format: ["UPPER_CASE"]
        },
        {
          selector: "parameter",
          format: ["camelCase"],
          leadingUnderscore: "allow"
        }
      ],
      "@typescript-eslint/indent": "off",
      "@typescript-eslint/no-empty-function": "warn",
      "@typescript-eslint/no-inferrable-types": "warn",
      "@typescript-eslint/no-this-alias": "warn",
      "prefer-const": "warn",
      "prefer-spread": "warn",
      "no-var": "warn",
      // note you must disable the base rule as it can report incorrect errors
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true }],
    }
  },
  {
    files: ["src/test/*.test.ts"],
    rules: {
      // this rule does not like `expect`, so it's very bad for tests
      "@typescript-eslint/no-unused-expressions": "off",
    }
  }
]);
