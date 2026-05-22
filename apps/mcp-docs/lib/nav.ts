export type NavItem = {
  title: string
  href: string
}

export type NavSection = {
  title: string
  items: NavItem[]
}

export const navigation: NavSection[] = [
  {
    title: 'Getting Started',
    items: [
      { title: 'Introduction', href: '/' },
      { title: 'Quickstart', href: '/quickstart' },
      { title: 'Authentication', href: '/authentication' },
    ],
  },
  {
    title: 'Clients',
    items: [
      { title: 'Claude Desktop', href: '/clients/claude-desktop' },
      { title: 'OpenCode', href: '/clients/opencode' },
      { title: 'Cursor & Others', href: '/clients/other' },
    ],
  },
  {
    title: 'Tools Reference',
    items: [
      { title: 'Overview', href: '/tools' },
      { title: 'Workspaces', href: '/tools/workspaces' },
      { title: 'Projects', href: '/tools/projects' },
      { title: 'Teams', href: '/tools/teams' },
      { title: 'Labels', href: '/tools/labels' },
      { title: 'Phases', href: '/tools/phases' },
      { title: 'Issues', href: '/tools/issues' },
      { title: 'Bulk Create Plan', href: '/tools/bulk-create-plan' },
    ],
  },
  {
    title: 'Guides',
    items: [
      { title: 'Plan a project from a prompt', href: '/guides/plan-from-prompt' },
      { title: 'Phase naming convention', href: '/guides/phase-naming' },
      { title: 'Troubleshooting', href: '/guides/troubleshooting' },
    ],
  },
]

export const flatNav = navigation.flatMap((s) => s.items)
