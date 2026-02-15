import { hc } from 'hono/client';
import type { AppType } from '@api/index';

const apiUrl = import.meta.env.VITE_API_URL;

export const client = hc<AppType>(apiUrl);
