/**
 * Reconciliation Service
 * 
 * Garantisce consistenza tra PostgreSQL e Qdrant attraverso:
 * - Health checks periodici
 * - Drift detection
 * - Auto-repair di inconsistenze
 * - Reindexing selettivo
 * 
 * @module archive/services/reconciliation
 */

import { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Tipi di inconsistenza rilevabili
 */
export const INCONSISTENCY_TYPES = {
  MISSING_IN_QDRANT: 'missing_in_qdrant',        // Doc in PG ma chunk assenti in Qdrant
  ORPHANED_IN_QDRANT: 'orphaned_in_qdrant',      // Chunk in Qdrant ma doc assente/cancellato in PG
  CHUNK_COUNT_MISMATCH: 'chunk_count_mismatch',  // Numero chunk diverso tra PG e Qdrant
  OUTDATED_METADATA: 'outdated_metadata',        // Metadata Qdrant non allineati con PG
};

/**
 * Reconciliation Service Class
 */
export class ReconciliationService {
  constructor({ pgPool, qdrantClient, logger, config = {} }) {
    this.pg = pgPool;
    this.qdrant = qdrantClient;
    this.logger = logger;

    this.config = {
      qdrantCollection: config.qdrantCollection || 'archive_document_chunks',
      batchSize: config.batchSize || 100,
      maxRetries: config.maxRetries || 3,
      autoRepair: config.autoRepair !== undefined ? config.autoRepair : true,
    };
  }

  /**
   * Health Check Completo
   * Verifica stato generale della sincronizzazione
   * 
   * @param {string} db - Database target
   * @returns {Promise<Object>}
   */
  async healthCheck(db) {
    this.logger.info(`[RECONCILIATION] Starting health check for db: ${db}`);

    const startTime = Date.now();

    try {
      // 1. Conta documenti indicizzati in PostgreSQL
      const pgCountResult = await this.pg.query(`
        SELECT COUNT(*) as count
        FROM archive_documents
        WHERE db = $1 
          AND is_current_version = TRUE 
          AND deleted_at IS NULL 
          AND pipeline_status = 'indexed'
      `, [db]);

      const pgDocCount = parseInt(pgCountResult.rows[0].count);

      // 2. Conta chunk in PostgreSQL
      const pgChunkResult = await this.pg.query(`
        SELECT COUNT(*) as count
        FROM archive_document_chunks c
        INNER JOIN archive_documents d ON d.id = c.document_id
        WHERE d.db = $1 
          AND d.is_current_version = TRUE 
          AND d.deleted_at IS NULL
          AND c.qdrant_point_id IS NOT NULL
      `, [db]);

      const pgChunkCount = parseInt(pgChunkResult.rows[0].count);

      // 3. Conta punti in Qdrant per questo db
      const qdrantCount = await this.qdrant.count(this.config.qdrantCollection, {
        filter: {
          must: [{ key: 'db', match: { value: db } }],
        },
      });

      const qdrantPointCount = qdrantCount.count;

      // 4. Calcola health score
      const chunkDrift = Math.abs(pgChunkCount - qdrantPointCount);
      const driftPercentage = pgChunkCount > 0 
        ? (chunkDrift / pgChunkCount) * 100 
        : 0;

      const isHealthy = driftPercentage < 1; // < 1% drift considerato sano

      const health = {
        status: isHealthy ? 'healthy' : driftPercentage < 5 ? 'degraded' : 'critical',
        timestamp: new Date().toISOString(),
        database: db,
        postgresql: {
          documents: pgDocCount,
          chunks: pgChunkCount,
        },
        qdrant: {
          points: qdrantPointCount,
        },
        drift: {
          absolute: chunkDrift,
          percentage: driftPercentage.toFixed(2),
        },
        duration_ms: Date.now() - startTime,
      };

      this.logger.info(`[RECONCILIATION] Health check completed: ${health.status}`, health);

      return health;

    } catch (error) {
      this.logger.error('[RECONCILIATION] Health check failed:', error);
      throw error;
    }
  }

  /**
   * Drift Detection
   * Identifica documenti con inconsistenze specifiche
   * 
   * @param {string} db - Database target
   * @param {Object} options - Opzioni detection
   * @returns {Promise<Object>}
   */
  async detectDrift(db, options = {}) {
    const {
      checkMissing = true,
      checkOrphaned = true,
      checkMismatch = true,
      limit = 1000,
    } = options;

    this.logger.info(`[RECONCILIATION] Starting drift detection for db: ${db}`);

    const inconsistencies = [];

    try {
      // 1. Documenti in PG ma chunk mancanti in Qdrant
      if (checkMissing) {
        const missingResult = await this.pg.query(`
          SELECT 
            d.id,
            d.title,
            d.pipeline_status,
            COUNT(c.id) as pg_chunk_count,
            COUNT(c.qdrant_point_id) as qdrant_ref_count
          FROM archive_documents d
          LEFT JOIN archive_document_chunks c ON c.document_id = d.id
          WHERE d.db = $1 
            AND d.is_current_version = TRUE 
            AND d.deleted_at IS NULL 
            AND d.pipeline_status = 'indexed'
          GROUP BY d.id, d.title, d.pipeline_status
          HAVING COUNT(c.id) > 0 AND COUNT(c.qdrant_point_id) = 0
          LIMIT $2
        `, [db, limit]);

        missingResult.rows.forEach(row => {
          inconsistencies.push({
            type: INCONSISTENCY_TYPES.MISSING_IN_QDRANT,
            document_id: row.id,
            title: row.title,
            details: {
              pg_status: row.pipeline_status,
              pg_chunks: parseInt(row.pg_chunk_count),
              qdrant_refs: parseInt(row.qdrant_ref_count),
            },
          });
        });
      }

      // 2. Documenti con count mismatch (chunk esistono ma count diverso)
      if (checkMismatch) {
        const mismatchResult = await this.pg.query(`
          WITH doc_chunks AS (
            SELECT 
              d.id as doc_id,
              d.title,
              COUNT(c.id) as pg_count,
              COUNT(c.qdrant_point_id) as qdrant_ref_count,
              ARRAY_AGG(c.qdrant_point_id) FILTER (WHERE c.qdrant_point_id IS NOT NULL) as point_ids
            FROM archive_documents d
            INNER JOIN archive_document_chunks c ON c.document_id = d.id
            WHERE d.db = $1 
              AND d.is_current_version = TRUE 
              AND d.deleted_at IS NULL
              AND d.pipeline_status = 'indexed'
            GROUP BY d.id, d.title
          )
          SELECT *
          FROM doc_chunks
          WHERE pg_count != qdrant_ref_count
          LIMIT $2
        `, [db, limit]);

        // Per ciascun documento, verifica esistenza punti in Qdrant
        for (const row of mismatchResult.rows) {
          const pointIds = row.point_ids;
          
          if (pointIds && pointIds.length > 0) {
            // Verifica esistenza punti in batch
            const existingPoints = await this.verifyQdrantPoints(pointIds);
            
            inconsistencies.push({
              type: INCONSISTENCY_TYPES.CHUNK_COUNT_MISMATCH,
              document_id: row.doc_id,
              title: row.title,
              details: {
                pg_chunks: parseInt(row.pg_count),
                pg_refs: parseInt(row.qdrant_ref_count),
                qdrant_existing: existingPoints.length,
                missing_point_ids: pointIds.filter(id => !existingPoints.includes(id)),
              },
            });
          }
        }
      }

      // 3. Punti orphaned in Qdrant (doc cancellato in PG)
      if (checkOrphaned) {
        // Recupera tutti doc_id da Qdrant per questo db
        const qdrantDocIds = await this.getQdrantDocumentIds(db);

        if (qdrantDocIds.size > 0) {
          const docIdsArray = Array.from(qdrantDocIds);
          
          // Query PG per verificare quali esistono
          const existingResult = await this.pg.query(`
            SELECT id
            FROM archive_documents
            WHERE db = $1 
              AND id = ANY($2)
              AND is_current_version = TRUE 
              AND deleted_at IS NULL
          `, [db, docIdsArray]);

          const existingIds = new Set(existingResult.rows.map(r => r.id));

          // Orphaned = in Qdrant ma non in PG (o cancellati)
          const orphanedIds = docIdsArray.filter(id => !existingIds.has(id));

          orphanedIds.forEach(docId => {
            inconsistencies.push({
              type: INCONSISTENCY_TYPES.ORPHANED_IN_QDRANT,
              document_id: docId,
              title: null,
              details: {
                reason: 'Document deleted or not found in PostgreSQL',
              },
            });
          });
        }
      }

      const summary = {
        database: db,
        timestamp: new Date().toISOString(),
        total_inconsistencies: inconsistencies.length,
        by_type: {
          missing_in_qdrant: inconsistencies.filter(i => i.type === INCONSISTENCY_TYPES.MISSING_IN_QDRANT).length,
          orphaned_in_qdrant: inconsistencies.filter(i => i.type === INCONSISTENCY_TYPES.ORPHANED_IN_QDRANT).length,
          chunk_count_mismatch: inconsistencies.filter(i => i.type === INCONSISTENCY_TYPES.CHUNK_COUNT_MISMATCH).length,
        },
        inconsistencies,
      };

      this.logger.info(`[RECONCILIATION] Drift detection completed`, summary);

      return summary;

    } catch (error) {
      this.logger.error('[RECONCILIATION] Drift detection failed:', error);
      throw error;
    }
  }

  /**
   * Auto-Repair Inconsistenze
   * Tenta riparazione automatica delle inconsistenze rilevate
   * 
   * @param {Array} inconsistencies - Lista inconsistenze da riparare
   * @param {Object} options - Opzioni riparazione
   * @returns {Promise<Object>}
   */
  async autoRepair(inconsistencies, options = {}) {
    const { dryRun = false, maxConcurrent = 5 } = options;

    this.logger.info(`[RECONCILIATION] Starting auto-repair (dryRun: ${dryRun})`);

    const results = {
      total: inconsistencies.length,
      repaired: 0,
      failed: 0,
      skipped: 0,
      actions: [],
    };

    // Raggruppa per tipo
    const byType = {};
    inconsistencies.forEach(inc => {
      if (!byType[inc.type]) byType[inc.type] = [];
      byType[inc.type].push(inc);
    });

    // 1. Ripara documenti mancanti in Qdrant (re-index)
    if (byType[INCONSISTENCY_TYPES.MISSING_IN_QDRANT]) {
      for (const inc of byType[INCONSISTENCY_TYPES.MISSING_IN_QDRANT]) {
        try {
          const action = {
            type: 'reindex_document',
            document_id: inc.document_id,
            title: inc.title,
          };

          if (!dryRun) {
            await this.reindexDocument(inc.document_id);
            action.status = 'success';
            results.repaired++;
          } else {
            action.status = 'would_repair';
            results.skipped++;
          }

          results.actions.push(action);

        } catch (error) {
          this.logger.error(`[RECONCILIATION] Failed to repair ${inc.document_id}:`, error);
          results.failed++;
          results.actions.push({
            type: 'reindex_document',
            document_id: inc.document_id,
            status: 'failed',
            error: error.message,
          });
        }
      }
    }

    // 2. Rimuovi punti orphaned da Qdrant
    if (byType[INCONSISTENCY_TYPES.ORPHANED_IN_QDRANT]) {
      for (const inc of byType[INCONSISTENCY_TYPES.ORPHANED_IN_QDRANT]) {
        try {
          const action = {
            type: 'delete_orphaned_points',
            document_id: inc.document_id,
          };

          if (!dryRun) {
            await this.deleteQdrantPointsByDocument(inc.document_id);
            action.status = 'success';
            results.repaired++;
          } else {
            action.status = 'would_repair';
            results.skipped++;
          }

          results.actions.push(action);

        } catch (error) {
          this.logger.error(`[RECONCILIATION] Failed to delete orphaned ${inc.document_id}:`, error);
          results.failed++;
          results.actions.push({
            type: 'delete_orphaned_points',
            document_id: inc.document_id,
            status: 'failed',
            error: error.message,
          });
        }
      }
    }

    // 3. Ripara chunk count mismatch (re-index parziale)
    if (byType[INCONSISTENCY_TYPES.CHUNK_COUNT_MISMATCH]) {
      for (const inc of byType[INCONSISTENCY_TYPES.CHUNK_COUNT_MISMATCH]) {
        try {
          const action = {
            type: 'fix_chunk_mismatch',
            document_id: inc.document_id,
            title: inc.title,
          };

          if (!dryRun) {
            // Elimina punti esistenti e re-index
            await this.deleteQdrantPointsByDocument(inc.document_id);
            await this.reindexDocument(inc.document_id);
            action.status = 'success';
            results.repaired++;
          } else {
            action.status = 'would_repair';
            results.skipped++;
          }

          results.actions.push(action);

        } catch (error) {
          this.logger.error(`[RECONCILIATION] Failed to fix mismatch ${inc.document_id}:`, error);
          results.failed++;
          results.actions.push({
            type: 'fix_chunk_mismatch',
            document_id: inc.document_id,
            status: 'failed',
            error: error.message,
          });
        }
      }
    }

    this.logger.info(`[RECONCILIATION] Auto-repair completed`, results);

    return results;
  }

  /**
   * Verifica esistenza punti in Qdrant
   * 
   * @param {Array} pointIds - Array UUID punti
   * @returns {Promise<Array>} Array UUID esistenti
   */
  async verifyQdrantPoints(pointIds) {
    try {
      const response = await this.qdrant.retrieve(this.config.qdrantCollection, {
        ids: pointIds,
        with_payload: false,
        with_vector: false,
      });

      return response.map(point => point.id);
    } catch (error) {
      this.logger.error('[RECONCILIATION] Failed to verify Qdrant points:', error);
      return [];
    }
  }

  /**
   * Recupera tutti document_id da Qdrant per un database
   * 
   * @param {string} db - Database
   * @returns {Promise<Set>}
   */
  async getQdrantDocumentIds(db) {
    const docIds = new Set();

    try {
      let offset = null;
      let hasMore = true;

      while (hasMore) {
        const scrollResult = await this.qdrant.scroll(this.config.qdrantCollection, {
          filter: {
            must: [{ key: 'db', match: { value: db } }],
          },
          limit: this.config.batchSize,
          with_payload: ['document_id'],
          with_vector: false,
          offset,
        });

        scrollResult.points.forEach(point => {
          if (point.payload?.document_id) {
            docIds.add(point.payload.document_id);
          }
        });

        offset = scrollResult.next_page_offset;
        hasMore = offset !== null && offset !== undefined;
      }

      return docIds;

    } catch (error) {
      this.logger.error('[RECONCILIATION] Failed to get Qdrant doc IDs:', error);
      throw error;
    }
  }

  /**
   * Elimina tutti i punti Qdrant per un documento
   * 
   * @param {string} documentId - ID documento
   */
  async deleteQdrantPointsByDocument(documentId) {
    try {
      await this.qdrant.delete(this.config.qdrantCollection, {
        filter: {
          must: [{ key: 'document_id', match: { value: documentId } }],
        },
      });

      this.logger.info(`[RECONCILIATION] Deleted Qdrant points for document: ${documentId}`);

    } catch (error) {
      this.logger.error(`[RECONCILIATION] Failed to delete Qdrant points for ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Re-indicizza un documento
   * Triggera la pipeline di embedding
   * 
   * @param {string} documentId - ID documento
   */
  async reindexDocument(documentId) {
    // Imposta stato a 'chunked' per far ripartire embedding worker
    await this.pg.query(`
      UPDATE archive_documents
      SET pipeline_status = 'chunked',
          pipeline_error = NULL
      WHERE id = $1
    `, [documentId]);

    // TODO: Enqueue job embedding se si usa pg-boss
    // await pgBoss.send('archive-embed', { documentId });

    this.logger.info(`[RECONCILIATION] Triggered reindex for document: ${documentId}`);
  }

  /**
   * Scheduled Reconciliation Job
   * Da eseguire periodicamente (es: ogni 6 ore)
   * 
   * @param {string} db - Database target
   */
  async scheduledReconciliation(db) {
    this.logger.info(`[RECONCILIATION] Starting scheduled reconciliation for db: ${db}`);

    try {
      // 1. Health check
      const health = await this.healthCheck(db);

      // 2. Se non healthy, esegui drift detection
      if (health.status !== 'healthy') {
        const drift = await this.detectDrift(db);

        // 3. Se auto-repair abilitato e ci sono inconsistenze, ripara
        if (this.config.autoRepair && drift.total_inconsistencies > 0) {
          const repairResult = await this.autoRepair(drift.inconsistencies, { dryRun: false });
          
          this.logger.info(`[RECONCILIATION] Auto-repair completed`, repairResult);

          return {
            health,
            drift,
            repair: repairResult,
          };
        }

        return { health, drift };
      }

      return { health };

    } catch (error) {
      this.logger.error(`[RECONCILIATION] Scheduled reconciliation failed for ${db}:`, error);
      throw error;
    }
  }
}

export default ReconciliationService;
