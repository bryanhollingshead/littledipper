import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :4000; the browser talks to Vite on :5173.
const api = process.env.LD_API || 'http://localhost:4000';
const proxy = Object.fromEntries(['/api', '/peer', '/public', '/.well-known'].map((p) => [p, { target: api, changeOrigin: false }]));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
});
