import type { UserConfig } from "vite";

export function glslTransform(code, id) {
    // For glsl file extensions, resolve `import foo from "./bar.frag"` to
    // the plain text source code of bar.frag.
    // JSON.stringify is required to escape special characters: backticks
    // in `code` would otherwise be interpreted as Javascript.
    // Unit test in vite.config.test.ts checks this.
    if (/\.(glsl|frag|vert|fs|vs)$/.test(id)) {
      return `export default ${JSON.stringify(code)};`;
    }
}

// We want to be able to import glsl shaders without url decorations like ?raw.
// This is because we still build the distribution with babel/tsc and don't want
// to use nonstandard import syntax there.
export default {
  plugins: [
    {
      name: "raw-shaders",
      transform: glslTransform,
    },
  ],
  define: {
    APP_VERSION: JSON.stringify(process.env.npm_package_version),
  },
  server: {
    open: "public/index.html",
  },
  worker: {
    format: "es",
  },
} satisfies UserConfig;
