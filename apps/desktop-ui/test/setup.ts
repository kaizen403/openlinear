import { vi } from 'vitest'

// Mock Tauri runtime — make it look like we're NOT in Tauri so useAuth skips setupTauri
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: undefined,
  writable: true,
  configurable: true,
})

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}))

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  },
  Toaster: () => null,
}))

// Mock next-themes
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// Mock @hello-pangea/dnd
vi.mock('@hello-pangea/dnd', () => ({
  DragDropContext: ({ children }: { children: React.ReactNode }) => children,
  Droppable: ({ children }: { children: any }) => children({ innerRef: vi.fn(), droppableProps: {}, placeholder: null }, { isDraggingOver: false }),
  Draggable: ({ children }: { children: any }) => children({ innerRef: vi.fn(), draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
  resetServerContext: vi.fn(),
}))

// Mock @tauri-apps/api dynamic imports
vi.mock('@tauri-apps/api', () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => () => {}),
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn().mockResolvedValue('linux'),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn(),
    set: vi.fn(),
    save: vi.fn(),
  }),
}))


// Provide a working localStorage mock that persists values between calls
const localStorageStore = new Map<string, string>()

const localStorageMock = {
  getItem: vi.fn((key: string) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => localStorageStore.set(key, value)),
  removeItem: vi.fn((key: string) => localStorageStore.delete(key)),
  clear: vi.fn(() => localStorageStore.clear()),
}

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
})
