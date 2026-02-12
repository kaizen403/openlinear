export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export function getAuthHeader(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
