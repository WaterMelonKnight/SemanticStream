import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rolldownOptions: {
      input: { demo: 'index.html', runtime: 'runtime.html', perception: 'perception.html', agent: 'agent.html' },
    },
  },
});
