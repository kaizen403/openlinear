export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function getClientHeader(): HeadersInit {
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  return isDesktop ? { 'x-openlinear-client': 'desktop' } : {};
}

export function getAuthHeader(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return {
    ...getClientHeader(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
