/**
 * Simple in-memory rate limiting middleware
 * Protegge endpoint dalle richieste eccessive
 * 
 * Features:
 * - Sliding window per IP
 * - Configurabile per endpoint
 * - Auto-cleanup expired entries
 * - Cache-friendly (usa timestamp)
 * 
 * @module lib/rateLimit
 */

class RateLimiter {
  constructor() {
    this.requests = new Map(); // IP -> array di timestamps
    
    // Cleanup ogni 60 secondi
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check se IP ha superato il limite
   * @param {string} ip - IP address
   * @param {number} maxRequests - Max richieste permesse
   * @param {number} windowMs - Finestra temporale in ms (es. 60000 = 1 minuto)
   * @returns {object} { allowed: boolean, remaining: number, resetTime: number }
   */
  check(ip, maxRequests = 100, windowMs = 60000) {
    const now = Date.now();
    const cutoff = now - windowMs;
    
    // Get existing requests for this IP
    let timestamps = this.requests.get(ip) || [];
    
    // Filter out requests outside the window
    timestamps = timestamps.filter(t => t > cutoff);
    
    // Check if limit exceeded
    if (timestamps.length >= maxRequests) {
      const oldestRequest = timestamps[0];
      const resetTime = oldestRequest + windowMs;
      
      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfter: Math.ceil((resetTime - now) / 1000), // secondi
      };
    }
    
    // Add current request
    timestamps.push(now);
    this.requests.set(ip, timestamps);
    
    return {
      allowed: true,
      remaining: maxRequests - timestamps.length,
      resetTime: now + windowMs,
      retryAfter: 0,
    };
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    const maxWindow = 3600000; // 1 hour max window
    const cutoff = now - maxWindow;
    let cleaned = 0;
    
    for (const [ip, timestamps] of this.requests.entries()) {
      // Filter timestamps
      const filtered = timestamps.filter(t => t > cutoff);
      
      if (filtered.length === 0) {
        this.requests.delete(ip);
        cleaned++;
      } else if (filtered.length < timestamps.length) {
        this.requests.set(ip, filtered);
      }
    }
    
    if (cleaned > 0) {
      console.log(`[RateLimit] Cleaned ${cleaned} expired IP entries`);
    }
  }

  /**
   * Reset limits for IP
   */
  reset(ip) {
    return this.requests.delete(ip);
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      trackedIPs: this.requests.size,
      totalRequests: Array.from(this.requests.values())
        .reduce((sum, timestamps) => sum + timestamps.length, 0),
    };
  }

  /**
   * Shutdown cleanup
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

/**
 * Fastify hook factory - crea preHandler per rate limiting
 * 
 * @param {number} maxRequests - Max richieste per finestra
 * @param {number} windowMs - Finestra temporale in ms
 * @example
 * fastify.get('/api', { preHandler: rateLimitHook(100, 60000) }, handler);
 */
export function rateLimitHook(maxRequests = 100, windowMs = 60000) {
  return async (request, reply) => {
    const ip = request.ip || request.raw.socket.remoteAddress || 'unknown';
    
    const result = rateLimiter.check(ip, maxRequests, windowMs);
    
    // Add headers
    reply.header('X-RateLimit-Limit', maxRequests);
    reply.header('X-RateLimit-Remaining', result.remaining);
    reply.header('X-RateLimit-Reset', result.resetTime);
    
    if (!result.allowed) {
      reply.header('Retry-After', result.retryAfter);
      reply.code(429).send({
        success: false,
        error: 'Too many requests',
        retryAfter: result.retryAfter,
      });
    }
  };
}

/**
 * Aggressive rate limit per endpoint costosi
 * 10 richieste al minuto
 */
export const analyticsRateLimit = rateLimitHook(10, 60000);

/**
 * Standard rate limit
 * 60 richieste al minuto
 */
export const standardRateLimit = rateLimitHook(60, 60000);

/**
 * Generous rate limit per operazioni comuni
 * 120 richieste al minuto
 */
export const generousRateLimit = rateLimitHook(120, 60000);
