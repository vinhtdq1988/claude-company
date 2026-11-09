import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      // Socket.IO dùng path /socket.io; namespace /realtime nằm trong giao thức, không phải đường dẫn HTTP.
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
