/**
 * Syntax-light colouring for diff lines: comments, strings, numbers and
 * keywords, per line, from the file extension. No dependency, no HTML — the
 * output is a list of text spans the viewer renders as React text nodes.
 *
 * Deliberately line-local: a line inside a multi-line string or block
 * comment is coloured as code (except the common `* …` doc-comment
 * continuation). That is the trade for O(line) cost on virtualized rows.
 */

export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number"

export interface SyntaxToken {
  kind: TokenKind
  text: string
}

interface LanguageSpec {
  lineComments: readonly string[]
  block: readonly [string, string] | null
  quotes: string
  keywords: ReadonlySet<string>
  caseInsensitive?: boolean
  /** Treat a line starting with `*` as a block-comment continuation. */
  docStar?: boolean
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean))

const JS_KEYWORDS = words(`
  abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do
  else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let
  module namespace never new null number object of override private protected public readonly return satisfies set static
  string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield
`)
const PY_KEYWORDS = words(`
  and as assert async await break class continue def del elif else except False finally for from global if import in is lambda
  None nonlocal not or pass raise return self True try while with yield match case
`)
const GO_KEYWORDS = words(`
  break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range
  return select struct switch true type var
`)
const RUST_KEYWORDS = words(`
  as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref
  return self Self static struct super trait true type unsafe use where while
`)
const C_KEYWORDS = words(`
  auto bool break case catch char class const continue default delete do double else enum explicit extern false final float for
  friend fun goto if import inline int interface internal let long namespace new null nullptr object override package private
  protected public return short signed sizeof static struct super switch template this throw true try typedef typename union
  unsigned using val var virtual void volatile when while
`)
const RUBY_KEYWORDS = words(`
  alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry
  return self super then true undef unless until when while yield
`)
const SH_KEYWORDS = words("case do done elif else esac export fi for function if in local return then until while")
const SQL_KEYWORDS = words(`
  add all alter and as asc by case check column constraint create default delete desc distinct drop else end exists foreign from
  group having in index insert into is join key left limit not null on or order primary references right select set table then
  union unique update values when where with
`)
const DATA_KEYWORDS = words("true false null yes no on off")
const CSS_KEYWORDS = words("important inherit initial unset none auto")

const C_FAMILY = { lineComments: ["//"], block: ["/*", "*/"] as const, quotes: "\"'`", docStar: true }

const LANGUAGES: Readonly<Record<string, LanguageSpec>> = {
  js: { ...C_FAMILY, keywords: JS_KEYWORDS },
  c: { ...C_FAMILY, quotes: "\"'", keywords: C_KEYWORDS },
  go: { ...C_FAMILY, keywords: GO_KEYWORDS },
  rust: { ...C_FAMILY, quotes: "\"", keywords: RUST_KEYWORDS },
  css: { lineComments: [], block: ["/*", "*/"], quotes: "\"'", keywords: CSS_KEYWORDS, docStar: true },
  py: { lineComments: ["#"], block: null, quotes: "\"'", keywords: PY_KEYWORDS },
  ruby: { lineComments: ["#"], block: null, quotes: "\"'", keywords: RUBY_KEYWORDS },
  sh: { lineComments: ["#"], block: null, quotes: "\"'", keywords: SH_KEYWORDS },
  data: { lineComments: ["#"], block: null, quotes: "\"'", keywords: DATA_KEYWORDS },
  json: { lineComments: [], block: null, quotes: "\"", keywords: DATA_KEYWORDS },
  sql: { lineComments: ["--"], block: ["/*", "*/"], quotes: "'\"", keywords: SQL_KEYWORDS, caseInsensitive: true },
  markup: { lineComments: [], block: ["<!--", "-->"], quotes: "\"'", keywords: words("") },
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", m: "c", mm: "c", java: "c", kt: "c", kts: "c", scala: "c",
  swift: "c", cs: "c", dart: "c", php: "c",
  go: "go", rs: "rust",
  css: "css", scss: "css", less: "css",
  py: "py", pyi: "py", rb: "ruby", rake: "ruby",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  yml: "data", yaml: "data", toml: "data", ini: "data", conf: "data", env: "data",
  json: "json", jsonc: "js", json5: "js",
  sql: "sql",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
}

const FILENAMES: Readonly<Record<string, string>> = {
  dockerfile: "sh", makefile: "sh", ".bashrc": "sh", ".zshrc": "sh", ".env": "data", gemfile: "ruby", rakefile: "ruby",
}

/** Language id for a path, or null (rendered as plain text). */
export function languageForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  if (FILENAMES[name]) return FILENAMES[name]!
  const dot = name.lastIndexOf(".")
  if (dot <= 0 && !name.startsWith(".")) return null
  return EXTENSIONS[name.slice(dot + 1)] ?? null
}

/** Longer lines are rendered plain: colouring them would cost more than it helps. */
export const MAX_HIGHLIGHT_CHARS = 2_000

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[\w$]/
const NUMBER_PART = /[\w.]/

function push(tokens: SyntaxToken[], kind: TokenKind, text: string): void {
  if (!text) return
  const last = tokens[tokens.length - 1]
  if (last && last.kind === kind) last.text += text
  else tokens.push({ kind, text })
}

export function tokenizeLine(text: string, language: string | null): SyntaxToken[] {
  const spec = language ? LANGUAGES[language] : undefined
  if (!spec || text.length === 0 || text.length > MAX_HIGHLIGHT_CHARS) return text ? [{ kind: "plain", text }] : []

  if (spec.docStar) {
    const trimmed = text.trimStart()
    if (trimmed === "*" || trimmed.startsWith("* ") || trimmed.startsWith("*/") || trimmed.startsWith("/**")) {
      return [{ kind: "comment", text }]
    }
  }

  const tokens: SyntaxToken[] = []
  let index = 0
  let plainStart = 0
  const flushPlain = (end: number) => {
    if (end > plainStart) push(tokens, "plain", text.slice(plainStart, end))
  }

  while (index < text.length) {
    const char = text[index]!

    const lineComment = spec.lineComments.find((marker) => text.startsWith(marker, index))
    if (lineComment) {
      flushPlain(index)
      push(tokens, "comment", text.slice(index))
      return tokens
    }

    if (spec.block && text.startsWith(spec.block[0], index)) {
      flushPlain(index)
      const close = text.indexOf(spec.block[1], index + spec.block[0].length)
      const end = close === -1 ? text.length : close + spec.block[1].length
      push(tokens, "comment", text.slice(index, end))
      index = end
      plainStart = end
      continue
    }

    if (spec.quotes.includes(char)) {
      flushPlain(index)
      let end = index + 1
      while (end < text.length) {
        const next = text[end]!
        if (next === "\\") {
          end += 2
          continue
        }
        end += 1
        if (next === char) break
      }
      end = Math.min(end, text.length)
      push(tokens, "string", text.slice(index, end))
      index = end
      plainStart = end
      continue
    }

    const prev = index > 0 ? text[index - 1]! : ""
    if (char >= "0" && char <= "9" && !IDENT_PART.test(prev)) {
      flushPlain(index)
      let end = index + 1
      while (end < text.length && NUMBER_PART.test(text[end]!)) end += 1
      push(tokens, "number", text.slice(index, end))
      index = end
      plainStart = end
      continue
    }

    if (IDENT_START.test(char) && !IDENT_PART.test(prev)) {
      let end = index + 1
      while (end < text.length && IDENT_PART.test(text[end]!)) end += 1
      const word = text.slice(index, end)
      if (spec.keywords.has(spec.caseInsensitive ? word.toLowerCase() : word)) {
        flushPlain(index)
        push(tokens, "keyword", word)
        plainStart = end
      }
      index = end
      continue
    }

    index += 1
  }
  flushPlain(text.length)
  return tokens
}
