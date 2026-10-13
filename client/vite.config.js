import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, API calls go to the Express server; in production Express serves this build.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
