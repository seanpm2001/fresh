import { gte, join, posix, relative, walk, WalkEntry } from "./deps.ts";
import { error } from "./error.ts";
const MIN_DENO_VERSION = "1.31.0";
const TEST_FILE_PATTERN = /[._]test\.(?:[tj]sx?|[mc][tj]s)$/;

export function ensureMinDenoVersion() {
  // Check that the minimum supported Deno version is being used.
  if (!gte(Deno.version.deno, MIN_DENO_VERSION)) {
    let message =
      `Deno version ${MIN_DENO_VERSION} or higher is required. Please update Deno.\n\n`;

    if (Deno.execPath().includes("homebrew")) {
      message +=
        "You seem to have installed Deno via homebrew. To update, run: `brew upgrade deno`\n";
    } else {
      message += "To update, run: `deno upgrade`\n";
    }

    error(message);
  }
}

async function collectDir(
  dir: string,
  callback: (entry: WalkEntry, dir: string) => void,
  ignoreFilePattern = TEST_FILE_PATTERN,
): Promise<void> {
  // Check if provided path is a directory
  try {
    const stat = await Deno.stat(dir);
    if (!stat.isDirectory) return;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }

  const routesFolder = walk(dir, {
    includeDirs: false,
    includeFiles: true,
    exts: ["tsx", "jsx", "ts", "js"],
    skip: [ignoreFilePattern],
  });

  for await (const entry of routesFolder) {
    callback(entry, dir);
  }
}

export interface Manifest {
  routes: string[];
  islands: string[];
}

const GROUP_REG = /[/\\\\]\((_[^/\\\\]+)\)[/\\\\]/;
export async function collect(
  directory: string,
  ignoreFilePattern?: RegExp,
): Promise<Manifest> {
  const filePaths = new Set<string>();

  const routes: string[] = [];
  const islands: string[] = [];
  await Promise.all([
    collectDir(join(directory, "./routes"), (entry, dir) => {
      const rel = join("routes", relative(dir, entry.path));
      const normalized = rel.slice(0, rel.lastIndexOf("."));

      // A `(_islands)` path segment is a local island folder.
      // Any route path segment wrapped in `(_...)` is ignored
      // during route collection.
      const match = normalized.match(GROUP_REG);
      if (match && match[1].startsWith("_")) {
        if (match[1] === "_islands") {
          islands.push(rel);
        }
        return;
      }

      if (filePaths.has(normalized)) {
        throw new Error(
          `Route conflict detected. Multiple files have the same name: ${dir}${normalized}`,
        );
      }
      filePaths.add(normalized);
      routes.push(rel);
    }, ignoreFilePattern),
    collectDir(join(directory, "./islands"), (entry, dir) => {
      const rel = join("islands", relative(dir, entry.path));
      islands.push(rel);
    }, ignoreFilePattern),
  ]);

  routes.sort();
  islands.sort();

  return { routes, islands };
}

/**
 * Import specifiers must have forward slashes
 */
function toImportSpecifier(file: string) {
  let specifier = posix.normalize(file).replace(/\\/g, "/");
  if (!specifier.startsWith(".")) {
    specifier = "./" + specifier;
  }
  return specifier;
}

export async function generate(directory: string, manifest: Manifest) {
  const { routes, islands } = manifest;

  const output = `// DO NOT EDIT. This file is generated by Fresh.
// This file SHOULD be checked into source version control.
// This file is automatically updated during development when running \`dev.ts\`.

${
    routes.map((file, i) =>
      `import * as $${i} from "${toImportSpecifier(file)}";`
    ).join(
      "\n",
    )
  }
${
    islands.map((file, i) =>
      `import * as $$${i} from "${toImportSpecifier(file)}";`
    )
      .join("\n")
  }

const manifest = {
  routes: {
    ${
    routes.map((file, i) =>
      `${JSON.stringify(`${toImportSpecifier(file)}`)}: $${i},`
    )
      .join("\n    ")
  }
  },
  islands: {
    ${
    islands.map((file, i) =>
      `${JSON.stringify(`${toImportSpecifier(file)}`)}: $$${i},`
    )
      .join("\n    ")
  }
  },
  baseUrl: import.meta.url,
};

export default manifest;
`;

  const proc = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();

  const raw = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(output));
      controller.close();
    },
  });
  await raw.pipeTo(proc.stdin);
  const { stdout } = await proc.output();

  const manifestStr = new TextDecoder().decode(stdout);
  const manifestPath = join(directory, "./fresh.gen.ts");

  await Deno.writeTextFile(manifestPath, manifestStr);
  console.log(
    `%cThe manifest has been generated for ${routes.length} routes and ${islands.length} islands.`,
    "color: blue; font-weight: bold",
  );
}
