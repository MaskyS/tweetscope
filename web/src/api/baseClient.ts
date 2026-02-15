import type { ApiError } from './types';

export const apiUrl = import.meta.env.VITE_API_URL;

export async function parseJson<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function parseText(response: Response): Promise<string> {
  return response.text();
}

export async function parseJsonOrThrow<T = unknown>(
  response: Response,
  message: string
): Promise<T> {
  if (!response.ok) {
    const err: ApiError = new Error(`${message} (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return (await response.json()) as T;
}
