#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")

const ROOT = path.resolve(__dirname, "..")
const FONT_DIR = path.join(ROOT, "apps", "desktop-ui", "public", "fonts")

const EXPECTED = [
  ["AnthropicSans-Regular.woff2", "Regular", 400, false],
  ["AnthropicSans-Medium.woff2", "Medium", 500, false],
  ["AnthropicSans-SemiBold.woff2", "SemiBold", 600, false],
  ["AnthropicSans-Bold.woff2", "Bold", 700, true],
]

const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post",
  "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
]

const FORBIDDEN_TABLES = new Set(["fvar", "avar", "gvar", "HVAR", "MVAR", "VVAR", "STAT"])
const FONT_CONFIG_FILES = [
  path.join(ROOT, "apps", "desktop-ui", "app", "globals.css"),
  path.join(ROOT, "apps", "desktop-ui", "tailwind.config.ts"),
]
const FORBIDDEN_ACTIVE_FAMILIES = [
  "sans-serif",
  "system-ui",
  "-apple-system",
  "Inter",
  "Geist",
  "Segoe UI",
  "Ubuntu",
]

function readBase128(buf, state) {
  let result = 0
  for (let i = 0; i < 5; i += 1) {
    const code = buf[state.offset]
    state.offset += 1
    if (i === 0 && code === 0x80) {
      throw new Error("invalid base128 encoding")
    }
    if ((result & 0xfe000000) !== 0) {
      throw new Error("base128 value overflow")
    }
    result = (result << 7) | (code & 0x7f)
    if ((code & 0x80) === 0) {
      return result
    }
  }
  throw new Error("base128 value too long")
}

function decodeUtf16be(buf) {
  let value = ""
  for (let i = 0; i + 1 < buf.length; i += 2) {
    value += String.fromCharCode(buf.readUInt16BE(i))
  }
  return value
}

function parseNameTable(data) {
  const format = data.readUInt16BE(0)
  if (format !== 0 && format !== 1) {
    throw new Error(`unsupported name table format ${format}`)
  }

  const count = data.readUInt16BE(2)
  const stringOffset = data.readUInt16BE(4)
  const names = new Map()

  for (let i = 0; i < count; i += 1) {
    const recordOffset = 6 + i * 12
    const platformId = data.readUInt16BE(recordOffset)
    const nameId = data.readUInt16BE(recordOffset + 6)
    const length = data.readUInt16BE(recordOffset + 8)
    const offset = data.readUInt16BE(recordOffset + 10)
    const raw = data.subarray(stringOffset + offset, stringOffset + offset + length)
    const value = platformId === 0 || platformId === 3
      ? decodeUtf16be(raw)
      : raw.toString("latin1")

    if (!names.has(nameId)) {
      names.set(nameId, value)
    }
  }

  return names
}

function parseWoff2(filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.toString("ascii", 0, 4) !== "wOF2") {
    throw new Error("not a WOFF2 font")
  }

  const numTables = buf.readUInt16BE(12)
  const totalCompressedSize = buf.readUInt32BE(20)
  const state = { offset: 48 }
  const entries = []

  for (let i = 0; i < numTables; i += 1) {
    const flags = buf[state.offset]
    state.offset += 1

    const tagIndex = flags & 0x3f
    const transformVersion = flags >> 6
    let tag
    if (tagIndex === 0x3f) {
      tag = buf.toString("ascii", state.offset, state.offset + 4)
      state.offset += 4
    } else {
      tag = KNOWN_TAGS[tagIndex]
    }
    if (!tag) {
      throw new Error(`unknown table tag index ${tagIndex}`)
    }

    const origLength = readBase128(buf, state)
    const isGlyfOrLoca = tag === "glyf" || tag === "loca"
    const transformed = isGlyfOrLoca ? transformVersion !== 3 : transformVersion !== 0
    const transformLength = transformed ? readBase128(buf, state) : origLength
    entries.push({ tag, origLength, transformLength })
  }

  const compressed = buf.subarray(state.offset, state.offset + totalCompressedSize)
  const tableData = zlib.brotliDecompressSync(compressed)
  const tables = new Map()
  let dataOffset = 0

  for (const entry of entries) {
    tables.set(entry.tag, tableData.subarray(dataOffset, dataOffset + entry.transformLength))
    dataOffset += entry.transformLength
  }

  return { entries, tables }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function verifyFont(fileName, style, weight, boldBit) {
  const filePath = path.join(FONT_DIR, fileName)
  const { entries, tables } = parseWoff2(filePath)
  const tableTags = new Set(entries.map((entry) => entry.tag))
  const forbidden = [...FORBIDDEN_TABLES].filter((tag) => tableTags.has(tag))
  if (forbidden.length > 0) {
    throw new Error(`${fileName}: contains variable/axis metadata tables: ${forbidden.join(", ")}`)
  }

  const names = parseNameTable(tables.get("name"))
  const os2 = tables.get("OS/2")
  expectEqual(os2.readUInt16BE(4), weight, `${fileName}: OS/2 usWeightClass`)

  const fsSelection = os2.readUInt16BE(62)
  const hasBoldBit = (fsSelection & (1 << 5)) !== 0
  const hasRegularBit = (fsSelection & (1 << 6)) !== 0
  const hasTypoMetricsBit = (fsSelection & (1 << 7)) !== 0
  expectEqual(hasBoldBit, boldBit, `${fileName}: OS/2 fsSelection bold bit`)
  expectEqual(hasRegularBit, weight === 400, `${fileName}: OS/2 fsSelection regular bit`)
  expectEqual(hasTypoMetricsBit, true, `${fileName}: OS/2 fsSelection use-typo-metrics bit`)

  expectEqual(names.get(1), "Anthropic Sans", `${fileName}: family name`)
  expectEqual(names.get(2), style, `${fileName}: subfamily name`)
  expectEqual(names.get(4), `Anthropic Sans ${style}`, `${fileName}: full name`)
  expectEqual(names.get(6), `AnthropicSans-${style}`, `${fileName}: PostScript name`)
  expectEqual(names.get(16), "Anthropic Sans", `${fileName}: typographic family name`)
  expectEqual(names.get(17), style, `${fileName}: typographic subfamily name`)

  const unique = names.get(3) || ""
  if (!unique.includes(`AnthropicSans-${style}`) || unique.includes("Variable") || unique.includes("TextRegular")) {
    throw new Error(`${fileName}: unique font id is not a static per-weight id: ${JSON.stringify(unique)}`)
  }

  if (names.has(25)) {
    throw new Error(`${fileName}: variation PostScript prefix nameID 25 must be stripped`)
  }
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function verifyNoAliasedFontFamilies() {
  for (const filePath of FONT_CONFIG_FILES) {
    const source = stripComments(fs.readFileSync(filePath, "utf8"))
    for (const family of FORBIDDEN_ACTIVE_FAMILIES) {
      if (source.includes(family)) {
        throw new Error(`${path.relative(ROOT, filePath)}: active font config contains ${family}`)
      }
    }
  }
}

let failures = 0
for (const expected of EXPECTED) {
  try {
    verifyFont(...expected)
    console.log(`ok ${expected[0]}`)
  } catch (error) {
    failures += 1
    console.error(`not ok ${expected[0]}`)
    console.error(`  ${error.message}`)
  }
}

try {
  verifyNoAliasedFontFamilies()
  console.log("ok desktop font fallback config")
} catch (error) {
  failures += 1
  console.error("not ok desktop font fallback config")
  console.error(`  ${error.message}`)
}

if (failures > 0) {
  process.exit(1)
}
