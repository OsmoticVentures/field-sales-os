// eslint-config-next 16 ships flat configs; the FlatCompat bridge it replaced
// crashed on a circular plugin object ("property 'react' closes the circle").
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "ios/**", "www/**"]),
]);
