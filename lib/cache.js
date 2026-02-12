/**
 * Simple in-memory cache con TTL
 * Soluzione leggera senza dipendenze esterne (Redis)
 * 
 * Features:
 * - TTL configurabile per key
 * - Auto-cleanup expired entries
 * - Namespace support per categorizzare entries
 * - Cache statistics
 * 
 * @module lib/cache
 */

class CacheManager {
  constructor() {
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
    };
    
    // Auto-cleanup ogni 60 secondi
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Genera cache key con namespace
   */
  _generateKey(namespace, key) {
    return `${namespace}:${key}`;
  }

  /**
   * Set value con TTL (in secondi)
   */
  set(namespace, key, value, ttlSeconds = 300) {
    const cacheKey = this._generateKey(namespace, key);
    const expiresAt = Date.now() + (ttlSeconds * 1000);
    
    this.cache.set(cacheKey, {
      value,
      expiresAt,
      createdAt: Date.now(),
    });
    
    this.stats.sets++;
  }

  /**
   * Get value se non expired
   */
  get(namespace, key) {
    const cacheKey = this._generateKey(namespace, key);
    const entry = this.cache.get(cacheKey);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(cacheKey);
      this.stats.evictions++;
      this.stats.misses++;
      return null;
    }
    
    this.stats.hits++;
    return entry.value;
  }

  /**
   * Delete specific key
   */
  delete(namespace, key) {
    const cacheKey = this._generateKey(namespace, key);
    return this.cache.delete(cacheKey);
  }

  /**
   * Delete all keys in namespace
   */
  deleteNamespace(namespace) {
    const prefix = `${namespace}:`;
    let count = 0;
    
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        count++;
      }
    }
    
    return count;
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
        this.stats.evictions++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[Cache] Cleaned ${cleaned} expired entries`);
    }
  }

  /**
   * Clear entire cache
   */
  clear() {
    const size = this.cache.size;
    this.cache.clear();
    return size;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;
    
    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      size: this.cache.size,
    };
  }

  /**
   * Shutdown cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton instance
export const cache = new CacheManager();

/**
 * Cache decorator per funzioni async
 * 
 * @example
 * const cachedFn = withCache('analytics', myExpensiveFunction, 300);
 * const result = await cachedFn('db1', 30);
 */
export function withCache(namespace, fn, ttlSeconds = 300) {
  return async (...args) => {
    const cacheKey = JSON.stringify(args);
    
    // Try cache first
    const cached = cache.get(namespace, cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }
    
    // Execute and cache
    const result = await fn(...args);
    cache.set(namespace, cacheKey, result, ttlSeconds);
    
    return { ...result, fromCache: false };
  };
}
