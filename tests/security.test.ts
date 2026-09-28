import { describe, expect, it } from 'vitest';
import { isSafeImageUrl, refuseUnsafeImageUrls, secureDocument } from '../src/security/content-limits';

function documentWith(objects: unknown[]): Record<string, unknown> {
  return { schemaVersion: 1, id: 'doc', objects, metadata: {} };
}

describe('isSafeImageUrl', () => {
  it('allows web, blob, relative and image data addresses', () => {
    for (const url of ['https://cdn.test/a.png', 'http://a.test/b.jpg', '/images/c.png', 'd.png', 'blob:https://app.test/1', 'data:image/png;base64,AAA']) {
      expect(isSafeImageUrl(url)).toBe(true);
    }
  });

  it('refuses script, file and non-image data addresses', () => {
    for (const url of ['javascript:alert(1)', ' JavaScript:alert(1)', 'vbscript:x', 'file:///etc/passwd', 'data:text/html,<script>', 'ftp://x']) {
      expect(isSafeImageUrl(url)).toBe(false);
    }
  });
});

describe('secureDocument', () => {
  it('removes keys that could change an object prototype', () => {
    const hostile = JSON.parse(
      '{"schemaVersion":1,"objects":[{"type":"Rect","__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}],"metadata":{"__proto__":{"admin":true}}}',
    );
    const cleaned = secureDocument(hostile) as { objects: Array<Record<string, unknown>>; metadata: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(cleaned.objects[0], '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cleaned.objects[0], 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cleaned.metadata, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses unsafe image addresses and names the object', () => {
    const objects = [{ type: 'Image', id: 'logo', src: 'javascript:alert(1)' }];
    expect(() => refuseUnsafeImageUrls(objects)).toThrow(
      expect.objectContaining({ code: 'UNSAFE_DOCUMENT', message: expect.stringContaining('object logo') }),
    );
  });

  it('checks pattern sources and images inside groups', () => {
    const objects = [
      { type: 'Group', objects: [{ type: 'Rect', id: 'tile', fill: { type: 'pattern', source: 'file:///secret.png' } }] },
    ];
    expect(() => refuseUnsafeImageUrls(objects)).toThrow(expect.objectContaining({ code: 'UNSAFE_DOCUMENT' }));
  });

  it('limits the number of objects and the nesting depth', () => {
    const many = documentWith(Array.from({ length: 11 }, () => ({ type: 'Rect' })));
    expect(() => secureDocument(many, { maxObjects: 10 })).toThrow(expect.objectContaining({ code: 'UNSAFE_DOCUMENT' }));

    let nested: Record<string, unknown> = { type: 'Rect' };
    for (let level = 0; level < 60; level += 1) nested = { type: 'Group', objects: [nested] };
    expect(() => secureDocument(documentWith([nested]))).toThrow(expect.objectContaining({ message: expect.stringContaining('levels deep') }));
    expect(() => secureDocument(documentWith([nested]), { maxDepth: 500 })).not.toThrow();
  });

  it('lets the app decide which addresses are allowed', () => {
    const objects = [{ type: 'Image', src: 'https://tracker.test/pixel.gif' }];
    const onlyOurCdn = (url: string) => url.startsWith('https://cdn.ours.test/');
    expect(() => refuseUnsafeImageUrls(objects, onlyOurCdn)).toThrow(expect.objectContaining({ code: 'UNSAFE_DOCUMENT' }));
  });

  it('never changes the input', () => {
    const input = documentWith([{ type: 'Rect', fill: 'red' }]);
    const copy = structuredClone(input);
    secureDocument(input);
    expect(input).toEqual(copy);
  });
});
