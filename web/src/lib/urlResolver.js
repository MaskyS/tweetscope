import { apiService } from './apiService';

// Singleton URL resolver with rate limiting and caching
class UrlResolver {
  constructor() {
    this.cache = new Map();
    this.pending = new Map(); // URLs currently being resolved
    this.queue = [];
    this.processing = false;
    this.concurrentLimit = 3; // Max concurrent requests
    this.batchSize = 5; // URLs per batch request
    this.batchDelay = 100; // ms between batches
  }

  async resolve(urls) {
    if (!urls || urls.length === 0) return [];

    // Check cache first
    const results = [];
    const uncached = [];

    for (const url of urls) {
      if (this.cache.has(url)) {
        results.push(this.cache.get(url));
      } else if (this.pending.has(url)) {
        // Wait for pending request
        results.push(await this.pending.get(url));
      } else {
        uncached.push(url);
      }
    }

    if (uncached.length === 0) {
      return results;
    }

    // Create promise for these URLs
    const promise = this._queueResolve(uncached);

    // Mark as pending
    for (const url of uncached) {
      this.pending.set(url, promise.then(res =>
        res.find(r => r.original === url) || { original: url, error: true }
      ));
    }

    const resolved = await promise;

    // Cache results and clear pending
    for (const result of resolved) {
      this.cache.set(result.original, result);
      this.pending.delete(result.original);
    }

    const finalResults = [...results, ...resolved];
    return finalResults;
  }

  _queueResolve(urls) {
    return new Promise((resolve) => {
      this.queue.push({ urls, resolve });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      // Collect URLs for batch (up to batchSize)
      const batch = [];
      const resolvers = [];

      while (this.queue.length > 0 && batch.length < this.batchSize) {
        const item = this.queue.shift();
        batch.push(...item.urls);
        resolvers.push(item);
      }

      // Dedupe URLs in batch
      const uniqueUrls = [...new Set(batch)];

      try {
        const data = await apiService.resolveUrls(uniqueUrls);
        const results = data.results || [];

        // Resolve all waiting promises
        for (const item of resolvers) {
          const itemResults = item.urls.map(url =>
            results.find(r => r.original === url) || { original: url, error: true }
          );
          item.resolve(itemResults);
        }
      } catch (error) {
        // On error, resolve with error results
        for (const item of resolvers) {
          item.resolve(item.urls.map(url => ({ original: url, error: true })));
        }
      }

      // Delay between batches
      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, this.batchDelay));
      }
    }

    this.processing = false;
  }

  // Clear cache (useful for testing or memory management)
  clearCache() {
    this.cache.clear();
  }
}

// Export singleton instance
export const urlResolver = new UrlResolver();
