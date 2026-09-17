import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = "D:/文件/Obsidian Vault/Floratina/.obsidian/plugins/refined-modal";
const assets = ["styles.css", "manifest.json"];

await mkdir(pluginDir, { recursive: true });

const options = {
  absWorkingDir: root,
  entryPoints: ["main.js"],
  outfile: path.join(pluginDir, "main.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["obsidian"],
  logLevel: "info",
  plugins: [{
    name: "deploy-assets",
    setup(build) {
      build.onLoad({ filter: /[/\\]main\.js$/ }, async (args) => ({
        contents: await readFile(args.path, "utf8"),
        loader: "js",
        resolveDir: path.dirname(args.path),
        watchFiles: [args.path, ...assets.map((name) => path.join(root, name))],
      }));
      build.onEnd(async (result) => {
        if (result.errors.length) return;
        // data.json belongs to Obsidian; never overwrite the user's settings.
        await Promise.all(assets.map((name) =>
          copyFile(path.join(root, name), path.join(pluginDir, name))
        ));
        console.log(`Built plugin → ${pluginDir}`);
      });
    },
  }],
};

if (process.argv.includes("--watch")) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
