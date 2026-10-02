import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/**
 * Test-only routes under /__test-assets__/ for image failures a real server
 * produces: missing files, server errors, slow answers, broken bytes, and
 * images with or without CORS headers.
 */
function testAssetRoutes(): Plugin {
  const pixel = readFileSync('tests/fixtures/pixel.png');
  // Roboto, Apache License 2.0.
  const font = readFileSync('tests/fixtures/fonts/Roboto-Medium.ttf');
  const arabicFont = readFileSync('tests/fixtures/fonts/Amiri-Regular.ttf');
  return {
    name: 'test-asset-routes',
    configureServer(server) {
      server.middlewares.use('/__test-assets__/', (request, response) => {
        const url = new URL(request.url ?? '/', 'http://test');
        const route = url.pathname.replace(/^\//, '');
        const sendPixel = (cors: boolean): void => {
          response.statusCode = 200;
          response.setHeader('Content-Type', 'image/png');
          response.setHeader('Cache-Control', 'no-store');
          // Vite's dev server adds CORS headers to every answer; take them off for the no-CORS image.
          if (cors) response.setHeader('Access-Control-Allow-Origin', '*');
          else response.removeHeader('Access-Control-Allow-Origin');
          response.end(pixel);
        };
        switch (route) {
          case 'pixel.png':
            return sendPixel(true);
          case 'roboto.ttf':
            response.statusCode = 200;
            response.setHeader('Content-Type', 'font/ttf');
            response.setHeader('Access-Control-Allow-Origin', '*');
            return response.end(font);
          case 'amiri.ttf':
            response.statusCode = 200;
            response.setHeader('Content-Type', 'font/ttf');
            response.setHeader('Access-Control-Allow-Origin', '*');
            return response.end(arabicFont);
          case 'big.png': {
            // A real picture padded past a few kilobytes, for size limits.
            response.statusCode = 200;
            response.setHeader('Content-Type', 'image/png');
            response.setHeader('Access-Control-Allow-Origin', '*');
            return response.end(Buffer.concat([pixel, Buffer.alloc(8192)]));
          }
          case 'no-cors.png':
            return sendPixel(false);
          case 'gone.png':
            response.statusCode = 404;
            response.setHeader('Access-Control-Allow-Origin', '*');
            return response.end('not found');
          case 'broken-server.png':
            response.statusCode = 500;
            response.setHeader('Access-Control-Allow-Origin', '*');
            return response.end('server error');
          case 'not-a-picture.png':
            response.statusCode = 200;
            response.setHeader('Content-Type', 'image/png');
            response.setHeader('Access-Control-Allow-Origin', '*');
            return response.end('these bytes are not a png');
          case 'slow.png': {
            const delay = Number(url.searchParams.get('ms') ?? '2000');
            const timer = setTimeout(() => sendPixel(true), delay);
            request.on('close', () => clearTimeout(timer));
            return;
          }
          default:
            response.statusCode = 404;
            return response.end('unknown test asset');
        }
      });
    },
  };
}

const onCI = Boolean(process.env.CI);

function browserProject(name: string, browser: 'chromium' | 'firefox' | 'webkit' = 'chromium') {
  return {
    name,
    include: ['tests/**/*.browser.test.ts'],
    provide: {
      budgetScale: onCI ? 3 : 1,
      checkBudgets: !(onCI && browser === 'webkit'),
    },
    browser: {
      enabled: true,
      provider: playwright(browser === 'chromium' ? { launchOptions: { args: ['--font-render-hinting=none'] } } : {}),
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
        plugins: [testAssetRoutes()],
        test: browserProject('browser-fabric7'),
      },
      {
        plugins: [testAssetRoutes()],
        resolve: {
          alias: [{ find: /^fabric$/, replacement: 'fabric6' }],
        },
        test: browserProject('browser-fabric6'),
      },
      {
        plugins: [testAssetRoutes()],
        test: browserProject('browser-firefox', 'firefox'),
      },
      {
        plugins: [testAssetRoutes()],
        test: browserProject('browser-webkit', 'webkit'),
      },
    ],
  },
});
