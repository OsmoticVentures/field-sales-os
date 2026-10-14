import { fileURLToPath } from "node:url";

// larger-text: every font one point larger. Turbopack resolves a plugin from
// its own build folder, so the local one is named by absolute path.
const largerText = fileURLToPath(new URL("./scripts/postcss/larger-text.cjs", import.meta.url));

const config = {
  plugins: { "@tailwindcss/postcss": {}, [largerText]: {} },
};

export default config;
