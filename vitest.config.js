import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '*.config.js',
        'cytoscape*.js',
        'dagre.js',
        'tippy*.js'
      ]
    },
    include: ['tests/**/*.{test,spec}.js'],
    benchmark: {
      include: ['tests/**/*.bench.js']
    }
  }
});
