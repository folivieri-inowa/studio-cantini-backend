/**
 * Classification Routes
 * API endpoints per sistema classificazione automatica transazioni
 * 
 * Routes:
 * - POST /v1/transaction/classify - Classifica singola transazione
 * - PUT /v1/transaction/classify/batch - Classifica multiple transazioni
 * - POST /v1/transaction/reindex - Re-indicizza collection Qdrant
 * - GET /v1/classification/metrics - Performance metrics
 * - GET /v1/classification/rules - Lista regole attive
 * - POST /v1/classification/rules - Crea nuova regola
 * 
 * @module routes/classifier
 */

import { classifyTransaction, reindexTransactions, indexSingleTransaction, indexBatchTransactions, analyzeFeedbackPatterns, calculateAnalytics } from '../lib/classifierService.js';
import { cache } from '../lib/cache.js';
import { analyticsRateLimit, standardRateLimit } from '../lib/rateLimit.js';

export default async function classifierRoutes(fastify, options) {
  
  // ==========================================
  // POST /v1/transaction/classify
  // Classifica singola transazione
  // ==========================================
  
  fastify.post('/classify', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['transaction', 'db'],
        properties: {
          db: { type: 'string' },
          transaction: {
            type: 'object',
            required: ['id', 'description', 'amount', 'date'],
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              amount: { type: 'number' },
              date: { type: 'string' },
              paymentType: { type: 'string' },
              ownerId: { type: 'string' },
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { transaction, db } = request.body;
    
    try {
      const result = await classifyTransaction(transaction, db, fastify.pg);
      
      // Salva metriche se classificazione riuscita
      if (result.success && result.classification) {
        await saveClassificationMetrics(
          transaction.id,
          db,
          result.classification,
          result.latency_ms,
          fastify.pg
        );
      }
      
      return reply.code(200).send(result);
      
    } catch (error) {
      fastify.log.error('Classification error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
        needs_review: true,
      });
    }
  });
  
  // ==========================================
  // PUT /v1/transaction/classify/batch
  // Classifica multiple transazioni in batch
  // ==========================================
  
  fastify.put('/classify/batch', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['transactions', 'db'],
        properties: {
          db: { type: 'string' },
          transactions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'description', 'amount', 'date'],
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                amount: { type: 'number' },
                date: { type: 'string' },
                paymentType: { type: 'string' },
                ownerId: { type: 'string' },
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { transactions, db } = request.body;
    
    try {
      // Classifica in parallelo (max 5 concurrent)
      const batchSize = 5;
      const results = [];
      
      for (let i = 0; i < transactions.length; i += batchSize) {
        const batch = transactions.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(t => classifyTransaction(t, db, fastify.pg))
        );
        results.push(...batchResults);
      }
      
      // Salva metriche per tutte le classificazioni riuscite
      const metricsPromises = results
        .filter(r => r.success && r.classification)
        .map((r, idx) => 
          saveClassificationMetrics(
            transactions[idx].id,
            db,
            r.classification,
            r.latency_ms,
            fastify.pg
          )
        );
      
      await Promise.all(metricsPromises);
      
      return reply.code(200).send({
        success: true,
        results,
        total: transactions.length,
        classified: results.filter(r => r.classification).length,
        needs_review: results.filter(r => r.needs_review).length,
      });
      
    } catch (error) {
      fastify.log.error('Batch classification error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // POST /v1/transaction/reindex
  // Re-indicizza collection Qdrant per un database
  // ==========================================
  
  fastify.post('/reindex', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['db'],
        properties: {
          db: { type: 'string' },
          limit: { type: 'number', default: 5000 },
        }
      }
    }
  }, async (request, reply) => {
    const { db, limit = 5000 } = request.body;
    
    try {
      const result = await reindexTransactions(db, fastify.pg, limit);
      return reply.code(200).send(result);
      
    } catch (error) {
      fastify.log.error('Reindex error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // POST /v1/classification/index-transaction
  // Indicizza singola transazione (apprendimento real-time)
  // ==========================================
  
  fastify.post('/index-transaction', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['db', 'transactionId'],
        properties: {
          db: { type: 'string' },
          transactionId: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { db, transactionId } = request.body;
    
    try {
      const result = await indexSingleTransaction(transactionId, db, fastify.pg);
      return reply.code(200).send(result);
      
    } catch (error) {
      fastify.log.error('Index single transaction error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // POST /v1/classification/index-batch
  // Indicizza batch di transazioni (ottimizzato per multi-classify)
  // ==========================================
  
  fastify.post('/index-batch', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['db', 'transactionIds'],
        properties: {
          db: { type: 'string' },
          transactionIds: { 
            type: 'array',
            items: { type: 'string' },
            maxItems: 50, // Limit batch size
          },
        }
      }
    }
  }, async (request, reply) => {
    const { db, transactionIds } = request.body;
    
    if (!transactionIds || transactionIds.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'transactionIds array is required and cannot be empty',
      });
    }
    
    if (transactionIds.length > 50) {
      return reply.code(400).send({
        success: false,
        error: 'Maximum 50 transactions per batch',
      });
    }
    
    try {
      const result = await indexBatchTransactions(transactionIds, db, fastify.pg);
      return reply.code(200).send(result);
      
    } catch (error) {
      fastify.log.error('Index batch transactions error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // GET /v1/classification/metrics
  // Performance metrics per database
  // ==========================================
  
  fastify.get('/metrics', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        required: ['db'],
        properties: {
          db: { type: 'string' },
          days: { type: 'number', default: 7 },
        }
      }
    }
  }, async (request, reply) => {
    const { db, days = 7 } = request.query;
    
    try {
      // Query metriche aggregate
      const query = `
        SELECT 
          stage_used,
          COUNT(*) as total,
          AVG(confidence)::numeric(5,2) as avg_confidence,
          STDDEV(confidence)::numeric(5,2) as stddev_confidence,
          AVG(latency_ms)::integer as avg_latency_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::integer as p95_latency_ms,
          COUNT(*) FILTER (WHERE confidence >= 85) as high_confidence_count,
          (COUNT(*) FILTER (WHERE confidence >= 85)::float / COUNT(*) * 100)::numeric(5,2) as high_confidence_pct,
          COUNT(*) FILTER (WHERE confidence < 70) as manual_review_count
        FROM classification_metrics
        WHERE db = $1
          AND created_at > NOW() - INTERVAL '${days} days'
        GROUP BY stage_used
        ORDER BY total DESC
      `;
      
      const result = await fastify.pg.query(query, [db]);
      
      // Query totali
      const totalsQuery = `
        SELECT 
          COUNT(*) as total_classifications,
          AVG(confidence)::numeric(5,2) as overall_avg_confidence,
          AVG(latency_ms)::integer as overall_avg_latency_ms
        FROM classification_metrics
        WHERE db = $1
          AND created_at > NOW() - INTERVAL '${days} days'
      `;
      
      const totalsResult = await fastify.pg.query(totalsQuery, [db]);
      
      return reply.code(200).send({
        success: true,
        data: {
          db,
          period_days: days,
          totals: totalsResult.rows[0],
          by_stage: result.rows,
        }
      });
      
    } catch (error) {
      fastify.log.error('Metrics query error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // GET /v1/classification/rules
  // Lista regole di classificazione attive
  // ==========================================
  
  fastify.get('/rules', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        required: ['db'],
        properties: {
          db: { type: 'string' },
          enabled: { type: 'boolean' },
        }
      }
    }
  }, async (request, reply) => {
    const { db, enabled } = request.query;
    
    try {
      let query = `
        SELECT 
          r.id,
          r.rule_name,
          r.priority,
          r.enabled,
          r.description_patterns,
          r.amount_min,
          r.amount_max,
          r.payment_types,
          r.category_id,
          c.name as category_name,
          r.subject_id,
          s.name as subject_name,
          r.detail_id,
          d.name as detail_name,
          r.confidence,
          r.reasoning,
          r.created_at,
          r.created_by
        FROM classification_rules r
        JOIN categories c ON r.category_id = c.id
        JOIN subjects s ON r.subject_id = s.id
        LEFT JOIN details d ON r.detail_id = d.id
        WHERE r.db = $1
      `;
      
      const params = [db];
      
      if (enabled !== undefined) {
        query += ` AND r.enabled = $2`;
        params.push(enabled);
      }
      
      query += ` ORDER BY r.priority DESC, r.id ASC`;
      
      const result = await fastify.pg.query(query, params);
      
      return reply.code(200).send({
        success: true,
        data: result.rows,
        count: result.rows.length,
      });
      
    } catch (error) {
      fastify.log.error('Rules query error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // POST /v1/classification/rules
  // Crea nuova regola di classificazione
  // ==========================================
  
  fastify.post('/rules', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['db', 'rule_name', 'category_id', 'subject_id'],
        properties: {
          db: { type: 'string' },
          rule_name: { type: 'string' },
          priority: { type: 'number', default: 50 },
          enabled: { type: 'boolean', default: true },
          description_patterns: { type: 'array', items: { type: 'string' } },
          amount_min: { type: 'number' },
          amount_max: { type: 'number' },
          payment_types: { type: 'array', items: { type: 'string' } },
          category_id: { type: 'string' },
          subject_id: { type: 'string' },
          detail_id: { type: 'string' },
          confidence: { type: 'number', default: 95 },
          reasoning: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const {
      db,
      rule_name,
      priority = 50,
      enabled = true,
      description_patterns,
      amount_min,
      amount_max,
      payment_types,
      category_id,
      subject_id,
      detail_id,
      confidence = 95,
      reasoning,
    } = request.body;
    
    try {
      // Valida che category, subject, detail esistano
      const validateQuery = `
        SELECT 
          c.id as category_id,
          s.id as subject_id,
          d.id as detail_id
        FROM categories c
        JOIN subjects s ON s.id = $2 AND s.category_id = c.id
        LEFT JOIN details d ON d.id = $3 AND d.subject_id = s.id
        WHERE c.id = $1 AND c.db = $4 AND s.db = $4
      `;
      
      const validateResult = await fastify.pg.query(validateQuery, [
        category_id,
        subject_id,
        detail_id || null,
        db
      ]);
      
      if (validateResult.rows.length === 0) {
        return reply.code(400).send({
          success: false,
          error: 'Invalid category_id, subject_id, or detail_id for this database',
        });
      }
      
      // Inserisci regola
      const insertQuery = `
        INSERT INTO classification_rules (
          db, rule_name, priority, enabled,
          description_patterns, amount_min, amount_max, payment_types,
          category_id, subject_id, detail_id,
          confidence, reasoning, created_by
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14
        )
        RETURNING *
      `;
      
      const result = await fastify.pg.query(insertQuery, [
        db,
        rule_name,
        priority,
        enabled,
        description_patterns || null,
        amount_min || null,
        amount_max || null,
        payment_types || null,
        category_id,
        subject_id,
        detail_id || null,
        confidence,
        reasoning || null,
        request.user?.email || 'system',
      ]);
      
      return reply.code(201).send({
        success: true,
        data: result.rows[0],
      });
      
    } catch (error) {
      fastify.log.error('Create rule error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // GET /v1/classification/suggested-rules
  // Analizza feedback e suggerisce nuove regole
  // OTTIMIZZATO: Cache con TTL 10 minuti
  // PROTETTO: Rate limit 60 richieste/minuto (permette uso slider)
  // ==========================================
  
  fastify.get('/suggested-rules', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        required: ['db'],
        properties: {
          db: { type: 'string' },
          min_occurrences: { type: 'number', default: 3, minimum: 2, maximum: 100 },
          min_consistency: { type: 'number', default: 0.70, minimum: 0.5, maximum: 1.0 },
        }
      }
    }
  }, async (request, reply) => {
    // Rate limiting check (60 req/min per permettere uso interattivo slider)
    await standardRateLimit(request, reply);
    if (reply.sent) return; // Se rate limit exceeded, già risposto con 429
    const { db, min_occurrences = 3, min_consistency = 0.70 } = request.query;
    
    try {
      // Check cache first (TTL: 10 minuti)
      const cacheKey = `${db}-${min_occurrences}-${min_consistency}`;
      const cached = cache.get('suggested_rules', cacheKey);
      
      if (cached) {
        return reply.code(200).send({
          success: true,
          data: cached,
          latency_ms: 0,
          cached: true,
        });
      }
      
      // Analizza pattern nei feedback per suggerire nuove regole
      const result = await analyzeFeedbackPatterns(
        db,
        fastify.pg,  // Pass the main pg connection pool
        parseInt(min_occurrences),
        parseFloat(min_consistency)
      );
      
      if (!result.success) {
        return reply.code(500).send({
          success: false,
          error: result.error || 'Failed to analyze feedback patterns',
        });
      }
      
      const responseData = {
        suggestions: result.suggestions,
        stats: result.stats,
      };
      
      // Cache result (TTL: 600 secondi = 10 minuti)
      cache.set('suggested_rules', cacheKey, responseData, 600);
      
      return reply.code(200).send({
        success: true,
        data: responseData,
        latency_ms: result.latency_ms,
        cached: false,
      });
      
    } catch (error) {
      fastify.log.error('Suggested rules error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // GET /v1/classification/analytics
  // Analytics e metriche del sistema
  // OTTIMIZZATO: Cache con TTL 5 minuti
  // PROTETTO: Rate limit 60 richieste/minuto (permette cambio periodo)
  // ==========================================
  
  fastify.get('/analytics', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        required: ['db'],
        properties: {
          db: { type: 'string' },
          days: { type: 'number', default: 30, minimum: 1, maximum: 365 },
        }
      }
    }
  }, async (request, reply) => {
    // Rate limiting check (60 req/min per permettere cambio periodo)
    await standardRateLimit(request, reply);
    if (reply.sent) return; // Se rate limit exceeded, già risposto con 429
    
    const { db, days = 30 } = request.query;
    
    try {
      // Check cache first (TTL: 5 minuti)
      const cacheKey = `${db}-${days}`;
      const cached = cache.get('analytics', cacheKey);
      
      if (cached) {
        return reply.code(200).send({
          success: true,
          data: cached,
          latency_ms: 0,
          cached: true,
        });
      }
      
      // Calcola analytics aggregati
      const result = await calculateAnalytics(
        db,
        fastify.pg,
        parseInt(days)
      );
      
      if (!result.success) {
        return reply.code(500).send({
          success: false,
          error: result.error || 'Failed to calculate analytics',
        });
      }
      
      // Cache result (TTL: 300 secondi = 5 minuti)
      cache.set('analytics', cacheKey, result.analytics, 300);
      
      return reply.code(200).send({
        success: true,
        data: result.analytics,
        latency_ms: result.latency_ms,
        cached: false,
      });
      
    } catch (error) {
      fastify.log.error('Analytics error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // PATCH /v1/classification/rules/:id
  // Aggiorna regola esistente
  // ==========================================
  
  fastify.patch('/rules/:id', {
    preHandler: fastify.authenticate,
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'number' }
        }
      },
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          priority: { type: 'number' },
          description_patterns: { type: 'array', items: { type: 'string' } },
          amount_min: { type: 'number' },
          amount_max: { type: 'number' },
          confidence: { type: 'number' },
          reasoning: { type: 'string' },
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const updates = request.body;
    
    try {
      // Build dynamic update query
      const fields = Object.keys(updates)
        .map((key, idx) => `${key} = $${idx + 2}`)
        .join(', ');
      
      if (fields.length === 0) {
        return reply.code(400).send({
          success: false,
          error: 'No fields to update',
        });
      }
      
      const query = `
        UPDATE classification_rules
        SET ${fields}, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;
      
      const values = [id, ...Object.values(updates)];
      const result = await fastify.pg.query(query, values);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: 'Rule not found',
        });
      }
      
      return reply.code(200).send({
        success: true,
        data: result.rows[0],
      });
      
    } catch (error) {
      fastify.log.error('Update rule error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // DELETE /v1/classification/rules/:id
  // Elimina regola
  // ==========================================
  
  fastify.delete('/rules/:id', {
    preHandler: fastify.authenticate,
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    
    try {
      const query = 'DELETE FROM classification_rules WHERE id = $1 RETURNING id';
      const result = await fastify.pg.query(query, [id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: 'Rule not found',
        });
      }
      
      return reply.code(200).send({
        success: true,
        message: 'Rule deleted',
      });
      
    } catch (error) {
      fastify.log.error('Delete rule error:', error);
      return reply.code(500).send({
        success: false,
        error: error.message,
      });
    }
  });
  
  // ==========================================
  // GET /v1/classification/health
  // Health check dettagliato con status servizi
  // ==========================================
  
  fastify.get('/health', async (request, reply) => {
    try {
      const { checkServicesHealth } = await import('../lib/classifierService.js');
      const health = await checkServicesHealth();
      
      const httpStatus = health.overall_status === 'healthy' ? 200 : 503;
      
      return reply.code(httpStatus).send({
        status: health.overall_status,
        timestamp: new Date().toISOString(),
        services: health.services,
        capabilities: health.capabilities,
      });
      
    } catch (error) {
      fastify.log.error('Health check error:', error);
      return reply.code(500).send({
        status: 'error',
        error: error.message,
      });
    }
  });
}

// ==========================================
// HELPERS
// ==========================================

/**
 * Salva metriche di classificazione per analytics
 */
async function saveClassificationMetrics(
  transactionId,
  db,
  classification,
  latencyMs,
  pg
) {
  try {
    const query = `
      INSERT INTO classification_metrics (
        db,
        transaction_id,
        stage_used,
        confidence,
        latency_ms,
        vector_score,
        amount_score,
        recency_score,
        frequency_score,
        candidates_count,
        cluster_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;
    
    await pg.query(query, [
      db,
      transactionId,
      classification.method,
      classification.confidence,
      latencyMs,
      classification.debug?.vector_score || null,
      classification.debug?.amount_score || null,
      classification.debug?.recency_score || null,
      classification.debug?.frequency_score || null,
      classification.debug?.candidates_count || null,
      classification.debug?.cluster_count || null,
    ]);
  } catch (error) {
    // Non bloccare la classificazione se salvataggio metriche fallisce
    console.warn('Failed to save classification metrics:', error);
  }
}
