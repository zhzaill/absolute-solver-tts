/**
 * In-memory audio store behind the same-origin route.
 *
 * The browser cannot fetch `http://127.0.0.1:18080/...` from the Harness
 * web origin: it is a cross-origin request, and a page served over https would
 * block it as mixed content. Synthesized audio therefore has to be re-served
 * from the Harness's own origin, which means holding the bytes somewhere the
 * route handler can reach.
 *
 * A bounded insertion-ordered Map is enough: synthesis is interactive, the
 * entries are small (a few hundred KB), and eviction order is exactly the
 * least-recently-used rule we want.
 */

import { createHash } from 'node:crypto';

export class AudioStore {
  /** @param {number} limit maximum retained entries */
  constructor(limit = 32) {
    this.limit = Math.max(1, Math.floor(limit));
    this.entries = new Map();
  }

  put(key, value) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { ...value, createdAt: Date.now() });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return key;
  }

  get(key) {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Touch for LRU ordering.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key) {
    return this.entries.has(key);
  }

  size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * Stable content key for one synthesis request. Identical requests reuse the
 * same URL, so a repeated sentence does not re-synthesize or re-download.
 */
export function audioKey({ baseUrl, model, voice, language, promptLanguage, speed, text }) {
  const material = JSON.stringify([baseUrl, model, voice, language, promptLanguage, speed, text]);
  return createHash('sha1').update(material, 'utf8').digest('hex').slice(0, 24);
}
