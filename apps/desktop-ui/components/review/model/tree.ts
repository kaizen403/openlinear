import type { DiffFile } from "@/lib/api/review"

/**
 * The changed-files tree: directories (single-child chains compressed, like
 * "src/components") with files as leaves, plus a flattening that respects
 * collapsed directories for the ARIA tree's roving focus.
 */

export interface TreeFileNode {
  kind: "file"
  id: string
  name: string
  path: string
  fileIndex: number
  file: DiffFile
}

export interface TreeDirNode {
  kind: "dir"
  id: string
  name: string
  path: string
  children: TreeNode[]
  additions: number
  deletions: number
  fileCount: number
}

export type TreeNode = TreeFileNode | TreeDirNode

interface MutableDir {
  name: string
  path: string
  dirs: Map<string, MutableDir>
  files: TreeFileNode[]
}

function finish(dir: MutableDir): TreeDirNode {
  const dirs = [...dir.dirs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(finish).map(compress)
  const files = [...dir.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const children: TreeNode[] = [...dirs, ...files]
  let additions = 0
  let deletions = 0
  let fileCount = 0
  for (const child of children) {
    if (child.kind === "file") {
      additions += child.file.additions
      deletions += child.file.deletions
      fileCount += 1
    } else {
      additions += child.additions
      deletions += child.deletions
      fileCount += child.fileCount
    }
  }
  return { kind: "dir", id: `d:${dir.path}`, name: dir.name, path: dir.path, children, additions, deletions, fileCount }
}

/** "a" → "b" → files  becomes  "a/b" → files. */
function compress(node: TreeDirNode): TreeDirNode {
  let current = node
  while (current.children.length === 1 && current.children[0]!.kind === "dir") {
    const only = current.children[0] as TreeDirNode
    current = { ...only, name: `${current.name}/${only.name}` }
  }
  return current
}

export function buildFileTree(files: readonly DiffFile[]): TreeNode[] {
  const root: MutableDir = { name: "", path: "", dirs: new Map(), files: [] }
  files.forEach((file, fileIndex) => {
    const parts = file.path.split("/").filter(Boolean)
    const name = parts.pop() ?? file.path
    let dir = root
    for (const part of parts) {
      let next = dir.dirs.get(part)
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: new Map(), files: [] }
        dir.dirs.set(part, next)
      }
      dir = next
    }
    dir.files.push({ kind: "file", id: `f:${file.path}`, name, path: file.path, fileIndex, file })
  })
  return finish(root).children
}

export interface VisibleTreeItem {
  node: TreeNode
  depth: number
  posinset: number
  setsize: number
  parentId: string | null
  expanded: boolean
}

export function flattenTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>, depth = 1, parentId: string | null = null, out: VisibleTreeItem[] = []): VisibleTreeItem[] {
  nodes.forEach((node, index) => {
    const expanded = node.kind === "dir" && !collapsed.has(node.id)
    out.push({ node, depth, posinset: index + 1, setsize: nodes.length, parentId, expanded })
    if (node.kind === "dir" && expanded) flattenTree(node.children, collapsed, depth + 1, node.id, out)
  })
  return out
}
