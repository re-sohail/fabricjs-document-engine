import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

function browserProject(name: string, browser: 'chromium' | 'firefox' | 'webkit' = 'chromium') {
  return {
    name,
    include: ['tests/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser, name }],
    },
  };
}

export default defineConfig({
  server: {
    host: true,
  },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/**/*.browser.test.ts'],
        },
      },
      {
        test: browserProject('browser-fabric7'),
      },
      {
        resolve: {
          alias: [{ find: /^fabric$/, replacement: 'fabric6' }],
        },
        test: browserProject('browser-fabric6'),
      },
      {
        test: browserProject('browser-firefox', 'firefox'),
      },
      {
        test: browserProject('browser-webkit', 'webkit'),
      },
    ],
  },
});
