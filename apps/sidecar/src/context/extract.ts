/**
 * W16b: what the repository context index reads from each tracked file —
 * which files are eligible at all (no vendored/generated trees, lockfiles,
 * secret-looking files, binaries or large files), the language, and the
 * declared symbols (regex-based, one pass over the lines) for TS/JS, Python,
 * Go, Rust, Java/Kotlin, Ruby and Markdown headings.
 *
 * Pure: no I/O.
 */

export const MAX_INDEXED_FILE_BYTES = 512 * 1024;
export const MAX_SYMBOLS_PER_FILE = 64;
const MAX_SYMBOL_CHARS = 80;
const BINARY_SNIFF_BYTES = 8_000;

export type SkipReason = 'vendored' | 'lockfile' | 'secret' | 'binary' | 'large' | 'unsafe-path';

/** Directory names whose subtrees are dependencies, build output or caches. */
const SKIPPED_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'third_party', 'third-party', 'dist', 'build', 'out', '.next',
  '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vercel', '.output', 'coverage', '.nyc_output', 'target',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.yarn', '.pnpm-store', 'Pods',
  'DerivedData', '.gradle', '.idea', '.terraform', 'site-packages', '.git', '.hg', '.svn',
  // secret stores checked into a tree by mistake
  '.ssh', '.gnupg', '.aws', '.docker',
]);

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'cargo.lock', 'poetry.lock',
  'pipfile.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'flake.lock', 'uv.lock', 'mix.lock', 'packages.lock.json',
  'podfile.lock', 'pubspec.lock', 'deno.lock', 'gradle.lockfile', 'package.resolved',
]);

/** File names that usually hold credentials. Matched against the lowercase base name. */
const SECRET_NAMES: readonly RegExp[] = [
  /^\.env(?:\..*)?$/,
  /^\.envrc$/,
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx|asc|gpg|tfstate|tfvars|crt|cer|der|p8|mobileprovision)$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,
  /^\.(?:npmrc|pypirc|netrc|htpasswd|git-credentials|pgpass|my\.cnf|dockercfg)$/,
  /^credentials(?:\..*)?$/,
  /^secrets?\.(?:json|ya?ml|toml|env|ini|txt|xml)$/,
  /^service[-_]?account.*\.json$/,
  /^.*\.tfstate\.backup$/,
];

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'avif', 'tif', 'tiff', 'psd', 'heic', 'pdf', 'zip', 'gz', 'tgz', 'bz2',
  'xz', '7z', 'rar', 'tar', 'jar', 'war', 'ear', 'class', 'dex', 'apk', 'ipa', 'dmg', 'iso', 'exe', 'dll', 'so', 'dylib', 'a', 'o',
  'obj', 'lib', 'bin', 'wasm', 'pyc', 'pyo', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'webm',
  'wav', 'ogg', 'flac', 'sqlite', 'sqlite3', 'db', 'node', 'pdb', 'sketch', 'fig', 'xd', 'ai', 'blend', 'glb', 'fbx', 'parquet',
]);

/** Minified or generated text that adds noise, not context. */
const GENERATED_SUFFIXES = ['.min.js', '.min.css', '.map', '.bundle.js', '.chunk.js', '.snap', '.pb.go', '_pb2.py', '.generated.ts', '.d.ts.map'];

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  rb: 'ruby', rake: 'ruby', md: 'markdown', mdx: 'markdown', markdown: 'markdown', rst: 'text', txt: 'text',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml',
  sql: 'sql', prisma: 'prisma', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  css: 'css', scss: 'css', sass: 'css', less: 'css', html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', astro: 'astro',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', m: 'objc', mm: 'objc', swift: 'swift',
  cs: 'csharp', fs: 'fsharp', php: 'php', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', lua: 'lua', dart: 'dart',
  r: 'r', jl: 'julia', zig: 'zig', nim: 'nim', tf: 'terraform', hcl: 'terraform', dockerfile: 'docker', gradle: 'gradle',
};

const NAMED_FILES: Readonly<Record<string, string>> = {
  dockerfile: 'docker', makefile: 'make', gemfile: 'ruby', rakefile: 'ruby', procfile: 'text', justfile: 'make',
};

function extensionOf(base: string): string {
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function languageOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return NAMED_FILES[base] ?? LANGUAGES[extensionOf(base)] ?? 'text';
}

function hasUnsafePathCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
    if (code === 0x3c || code === 0x3e || code === 0x60) return true;
  }
  return false;
}

/**
 * Why a tracked path is not indexed (null = eligible). `size` is the blob
 * size from `git ls-tree -l`.
 */
export function skipReason(path: string, size: number): SkipReason | null {
  // Control characters, bidi overrides and angle brackets have no place in a
  // path we would show to an agent; such files are not indexed at all.
  if (hasUnsafePathCharacter(path)) return 'unsafe-path';
  const segments = path.split('/');
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  for (const segment of segments.slice(0, -1)) {
    if (SKIPPED_DIRS.has(segment)) return 'vendored';
  }
  if (LOCKFILES.has(base) || base.endsWith('.lock')) return 'lockfile';
  if (SECRET_NAMES.some((pattern) => pattern.test(base))) return 'secret';
  if (BINARY_EXTENSIONS.has(extensionOf(base))) return 'binary';
  if (GENERATED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return 'vendored';
  if (size > MAX_INDEXED_FILE_BYTES) return 'large';
  return null;
}

/** A NUL byte in the first 8 KB (git's own heuristic). */
export function looksBinary(content: Buffer): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

const IDENT = '[A-Za-z_$][\\w$]*';

/** Per-language declaration patterns; the first capture group is the symbol. */
const SYMBOL_PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  typescript: [
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`),
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?(?:interface|type|enum|namespace|module)\\s+(${IDENT})`),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*[:=]`),
    new RegExp(`^\\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*(${IDENT})\\s*(?:<[^>]*>)?\\([^)]*\\)?\\s*(?::[^{=]*)?\\{\\s*$`),
  ],
  python: [
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
    /^\s*class\s+([A-Za-z_]\w*)/,
    /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]*)?=/,
  ],
  go: [
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /^type\s+([A-Za-z_]\w*)/,
    /^(?:var|const)\s+([A-Za-z_]\w*)/,
  ],
  rust: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(?:fn|struct|enum|trait|type|mod|const|static|union)\s+([A-Za-z_]\w*)/,
    /^\s*impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/,
    /^\s*macro_rules!\s*([A-Za-z_]\w*)/,
  ],
  java: [
    /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/,
    /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+[\w<>[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\(/,
  ],
  kotlin: [
    /^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|inline|value|enum|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/,
    /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/,
  ],
  ruby: [
    /^\s*def\s+(?:self\.)?([A-Za-z_][\w]*[?!=]?)/,
    /^\s*(?:class|module)\s+([A-Z][\w:]*)/,
  ],
  markdown: [/^#{1,6}\s+(.+?)\s*#*\s*$/],
  prisma: [/^\s*(?:model|enum|type|view)\s+([A-Za-z_]\w*)/],
  graphql: [/^\s*(?:type|input|interface|enum|union|scalar)\s+([A-Za-z_]\w*)/],
  sql: [/^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|index|type)\s+(?:if\s+not\s+exists\s+)?["`]?([A-Za-z_][\w.]*)/i],
};

const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'constructor', 'super', 'else', 'do', 'try']);

function patternsFor(language: string): readonly RegExp[] {
  if (language === 'javascript' || language === 'vue' || language === 'svelte' || language === 'astro') return SYMBOL_PATTERNS.typescript ?? [];
  return SYMBOL_PATTERNS[language] ?? [];
}

export interface SymbolHit {
  name: string;
  /** 1-based line of the declaration. */
  line: number;
}

/** Declared symbols in file order (first occurrence of each name), at most MAX_SYMBOLS_PER_FILE. */
export function extractSymbols(language: string, lines: readonly string[]): SymbolHit[] {
  const patterns = patternsFor(language);
  if (patterns.length === 0) return [];
  const seen = new Set<string>();
  const out: SymbolHit[] = [];
  let fenced = false;
  for (let index = 0; index < lines.length && out.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index] ?? '';
    if (line.length > 400) continue;
    if (language === 'markdown' && /^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      const name = match?.[1]?.trim().slice(0, MAX_SYMBOL_CHARS);
      if (!name || NOT_METHODS.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, line: index + 1 });
      break;
    }
  }
  return out;
}

/** True for lines that carry no information on their own (blank, braces, comment markers). */
export function isTrivialLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || /^(?:[{}()[\];,]+|\/\/+|#+|\/\*+|\*+\/?|\*|<!--|-->|"""|''')$/.test(trimmed);
}
