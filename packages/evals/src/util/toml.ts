/**
 * A small TOML reader covering what Harbor `task.toml` files use: comments,
 * `[table]` / `[a.b]` / `[[array.of.tables]]` headers, bare/quoted/dotted
 * keys, basic/literal/multi-line strings, integers, floats, booleans,
 * multi-line arrays and inline tables. Offset date-times are returned as
 * strings. It is a reader for trusted-format metadata, not a validator: the
 * result is always passed through a Zod schema afterwards.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`TOML line ${line}: ${message}`);
    this.name = 'TomlError';
  }
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  private get line(): number {
    let count = 1;
    for (let i = 0; i < this.pos && i < this.src.length; i += 1) if (this.src[i] === '\n') count += 1;
    return count;
  }

  private fail(message: string): never {
    throw new TomlError(message, this.line);
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  private startsWith(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  /** Spaces and tabs only. */
  private skipInline(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos += 1;
  }

  private skipComment(): void {
    if (this.peek() === '#') while (this.pos < this.src.length && this.peek() !== '\n') this.pos += 1;
  }

  /** Whitespace, newlines and comments (inside arrays / between statements). */
  private skipAll(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.pos += 1;
      else if (c === '#') this.skipComment();
      else return;
    }
  }

  private expectLineEnd(): void {
    this.skipInline();
    this.skipComment();
    if (this.peek() === '\r') this.pos += 1;
    if (this.pos < this.src.length && this.peek() !== '\n') this.fail(`unexpected ${JSON.stringify(this.peek())}`);
  }

  parse(): TomlTable {
    const root: TomlTable = {};
    let current = root;
    while (this.pos < this.src.length) {
      this.skipAll();
      if (this.pos >= this.src.length) break;
      if (this.startsWith('[[')) {
        this.pos += 2;
        const path = this.parseKeyPath(']');
        if (!this.startsWith(']]')) this.fail('expected ]]');
        this.pos += 2;
        this.expectLineEnd();
        const parent = this.descend(root, path.slice(0, -1));
        const last = path[path.length - 1] as string;
        const existing = parent[last];
        const table: TomlTable = {};
        if (existing === undefined) parent[last] = [table];
        else if (Array.isArray(existing)) existing.push(table);
        else this.fail(`${last} is not an array of tables`);
        current = table;
      } else if (this.peek() === '[') {
        this.pos += 1;
        const path = this.parseKeyPath(']');
        if (this.peek() !== ']') this.fail('expected ]');
        this.pos += 1;
        this.expectLineEnd();
        current = this.descend(root, path);
      } else {
        this.parseKeyValue(current);
        this.expectLineEnd();
      }
    }
    return root;
  }

  private descend(base: TomlTable, path: readonly string[]): TomlTable {
    let table = base;
    for (const key of path) {
      const next = table[key];
      if (next === undefined) {
        const created: TomlTable = {};
        table[key] = created;
        table = created;
      } else if (isTable(next)) {
        table = next;
      } else if (Array.isArray(next) && isTable(next[next.length - 1])) {
        table = next[next.length - 1] as TomlTable;
      } else {
        this.fail(`${key} is not a table`);
      }
    }
    return table;
  }

  private parseKeyPath(terminator: string): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipInline();
      parts.push(this.parseKey());
      this.skipInline();
      if (this.peek() === '.') {
        this.pos += 1;
        continue;
      }
      if (this.peek() === terminator || terminator === '=') return parts;
      this.fail(`unexpected ${JSON.stringify(this.peek())} in key`);
    }
  }

  private parseKey(): string {
    const c = this.peek();
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    const start = this.pos;
    while (/[A-Za-z0-9_-]/.test(this.peek())) this.pos += 1;
    if (start === this.pos) this.fail('expected a key');
    return this.src.slice(start, this.pos);
  }

  private parseKeyValue(target: TomlTable): void {
    const path = this.parseKeyPath('=');
    this.skipInline();
    if (this.peek() !== '=') this.fail('expected =');
    this.pos += 1;
    this.skipInline();
    const value = this.parseValue();
    const table = this.descend(target, path.slice(0, -1));
    const last = path[path.length - 1] as string;
    if (last in table) this.fail(`duplicate key ${last}`);
    table[last] = value;
  }

  private parseValue(): TomlValue {
    const c = this.peek();
    if (this.startsWith('"""')) return this.parseMultilineBasic();
    if (this.startsWith("'''")) return this.parseMultilineLiteral();
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseInlineTable();
    if (this.startsWith('true')) {
      this.pos += 4;
      return true;
    }
    if (this.startsWith('false')) {
      this.pos += 5;
      return false;
    }
    return this.parseScalar();
  }

  private parseScalar(): TomlValue {
    const start = this.pos;
    while (this.pos < this.src.length && !/[\s,\]}#]/.test(this.peek())) this.pos += 1;
    // Offset date-times may contain one space between date and time.
    if (/^\d{4}-\d{2}-\d{2}$/.test(this.src.slice(start, this.pos)) && this.peek() === ' ' && /\d/.test(this.peek(1))) {
      this.pos += 1;
      while (this.pos < this.src.length && !/[\s,\]}#]/.test(this.peek())) this.pos += 1;
    }
    const raw = this.src.slice(start, this.pos);
    if (!raw) this.fail('expected a value');
    if (/^\d{4}-\d{2}-\d{2}/.test(raw) || /^\d{2}:\d{2}/.test(raw)) return raw;
    const cleaned = raw.replace(/_/g, '');
    if (cleaned === 'inf' || cleaned === '+inf') return Number.POSITIVE_INFINITY;
    if (cleaned === '-inf') return Number.NEGATIVE_INFINITY;
    if (/^[+-]?nan$/.test(cleaned)) return Number.NaN;
    if (/^0x[0-9a-fA-F]+$/.test(cleaned)) return Number.parseInt(cleaned.slice(2), 16);
    if (/^0o[0-7]+$/.test(cleaned)) return Number.parseInt(cleaned.slice(2), 8);
    if (/^0b[01]+$/.test(cleaned)) return Number.parseInt(cleaned.slice(2), 2);
    if (/^[+-]?(\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(cleaned)) return Number(cleaned);
    this.fail(`invalid value ${JSON.stringify(raw)}`);
  }

  private parseEscape(): string {
    const c = this.peek();
    this.pos += 1;
    switch (c) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case 'e':
        return '\u001b';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const length = c === 'u' ? 4 : 8;
        const hex = this.src.slice(this.pos, this.pos + length);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) this.fail('invalid unicode escape');
        this.pos += length;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      default:
        return this.fail(`invalid escape \\${c}`);
    }
  }

  private parseBasicString(): string {
    this.pos += 1;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === '' || c === '\n') this.fail('unterminated string');
      this.pos += 1;
      if (c === '"') return out;
      if (c === '\\') out += this.parseEscape();
      else out += c;
    }
  }

  private parseLiteralString(): string {
    this.pos += 1;
    const end = this.src.indexOf("'", this.pos);
    const newline = this.src.indexOf('\n', this.pos);
    if (end === -1 || (newline !== -1 && newline < end)) this.fail('unterminated literal string');
    const out = this.src.slice(this.pos, end);
    this.pos = end + 1;
    return out;
  }

  private parseMultilineBasic(): string {
    this.pos += 3;
    if (this.peek() === '\r') this.pos += 1;
    if (this.peek() === '\n') this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length) this.fail('unterminated multi-line string');
      if (this.startsWith('"""')) {
        this.pos += 3;
        return out;
      }
      const c = this.peek();
      this.pos += 1;
      if (c === '\\') {
        if (/[ \t\r\n]/.test(this.peek())) {
          while (/[ \t\r\n]/.test(this.peek())) this.pos += 1;
        } else {
          out += this.parseEscape();
        }
      } else {
        out += c;
      }
    }
  }

  private parseMultilineLiteral(): string {
    this.pos += 3;
    if (this.peek() === '\r') this.pos += 1;
    if (this.peek() === '\n') this.pos += 1;
    const end = this.src.indexOf("'''", this.pos);
    if (end === -1) this.fail('unterminated multi-line literal string');
    const out = this.src.slice(this.pos, end);
    this.pos = end + 3;
    return out;
  }

  private parseArray(): TomlValue[] {
    this.pos += 1;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipAll();
      if (this.peek() === ']') {
        this.pos += 1;
        return out;
      }
      out.push(this.parseValue());
      this.skipAll();
      if (this.peek() === ',') {
        this.pos += 1;
        continue;
      }
      if (this.peek() === ']') {
        this.pos += 1;
        return out;
      }
      this.fail('expected , or ] in array');
    }
  }

  private parseInlineTable(): TomlTable {
    this.pos += 1;
    const out: TomlTable = {};
    this.skipInline();
    if (this.peek() === '}') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipInline();
      this.parseKeyValue(out);
      this.skipInline();
      if (this.peek() === ',') {
        this.pos += 1;
        continue;
      }
      if (this.peek() === '}') {
        this.pos += 1;
        return out;
      }
      this.fail('expected , or } in inline table');
    }
  }
}

export function parseToml(source: string): TomlTable {
  return new Parser(source).parse();
}
