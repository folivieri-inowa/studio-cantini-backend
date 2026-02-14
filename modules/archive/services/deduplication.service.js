/**
 * Deduplication Service
 * 
 * Rileva e previene duplicati attraverso:
 * - Hash-based detection (SHA-256 del file)
 * - Similarity check via embeddings (fuzzy duplicates)
 * - Content fingerprinting
 * 
 * @module archive/services/deduplication
 */

import crypto from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Tipi di duplicazione rilevabili
 */
export const DUPLICATE_TYPES = {
  EXACT: 'exact',               // Hash identico
  NEAR: 'near',                 // Similarity > soglia
  CONTENT: 'content',           // Stesso contenuto ma formato diverso
  VERSION: 'version',           // Versione aggiornata dello stesso documento
};

/**
 * Deduplication Service
 */
export class DeduplicationService {
  constructor({ pgPool, qdrantClient, ollamaClient, logger, config = {} }) {
    this.pg = pgPool;
    this.qdrant = qdrantClient;
    this.ollama = ollamaClient;
    this.logger = logger;

    this.config = {
      qdrantCollection: config.qdrantCollection || 'archive_document_chunks',
      embeddingModel: config.embeddingModel || 'bge-m3',
      similarityThreshold: config.similarityThreshold || 0.95,  // 95% similarity = near duplicate
      contentSampleSize: config.contentSampleSize || 1000,      // Primi 1000 char per fingerprint
      enableFuzzyDetection: config.enableFuzzyDetection !== undefined 
        ? config.enableFuzzyDetection 
        : true,
    };
  }

  /**
   * Check duplicati completo per nuovo documento
   * 
   * @param {Buffer|Stream} fileBuffer - Contenuto file
   * @param {string} filename - Nome file
   * @param {string} db - Database
   * @param {Object} metadata - Metadata documento
   * @returns {Promise<Object>}
   */
  async checkDuplicates(fileBuffer, filename, db, metadata = {}) {
    this.logger.info(`[DEDUP] Checking duplicates for: ${filename}`);

    const results = {
      is_duplicate: false,
      duplicate_type: null,
      existing_document: null,
      similarity_score: null,
      suggestions: [],
    };

    try {
      // 1. Hash-based check (exact duplicate)
      const fileHash = this.computeFileHash(fileBuffer);
      const exactMatch = await this.findExactDuplicate(fileHash, db);

      if (exactMatch) {
        results.is_duplicate = true;
        results.duplicate_type = DUPLICATE_TYPES.EXACT;
        results.existing_document = exactMatch;
        results.similarity_score = 1.0;
        
        this.logger.info(`[DEDUP] Exact duplicate found: ${exactMatch.id}`);
        return results;
      }

      // 2. Fuzzy detection (se abilitata)
      if (this.config.enableFuzzyDetection && metadata.extracted_text) {
        const fuzzyMatches = await this.findFuzzyDuplicates(
          metadata.extracted_text,
          db,
          metadata
        );

        if (fuzzyMatches.length > 0) {
          const best = fuzzyMatches[0];
          
          if (best.similarity >= this.config.similarityThreshold) {
            results.is_duplicate = true;
            results.duplicate_type = DUPLICATE_TYPES.NEAR;
            results.existing_document = best;
            results.similarity_score = best.similarity;
            results.suggestions = fuzzyMatches.slice(1, 4); // Top 3 alternative matches

            this.logger.info(`[DEDUP] Near duplicate found: ${best.id} (similarity: ${best.similarity})`);
            return results;
          }

          // Similarity bassa ma non abbastanza per bloccare: suggerisci
          results.suggestions = fuzzyMatches.slice(0, 5);
        }
      }

      // 3. Content fingerprint check (filename + metadata)
      const contentMatch = await this.findContentDuplicate(filename, metadata, db);
      
      if (contentMatch) {
        results.suggestions.push({
          ...contentMatch,
          reason: 'Similar filename and metadata',
        });
      }

      this.logger.info(`[DEDUP] No duplicates found for: ${filename}`);
      return results;

    } catch (error) {
      this.logger.error('[DEDUP] Duplicate check failed:', error);
      // In caso di errore, permetti upload (fail-open)
      return results;
    }
  }

  /**
   * Compute SHA-256 hash del file
   * 
   * @param {Buffer} buffer - File buffer
   * @returns {string} Hash hex
   */
  computeFileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Compute content fingerprint
   * Hash del contenuto normalizzato (primi N caratteri)
   * 
   * @param {string} text - Testo estratto
   * @returns {string} Fingerprint
   */
  computeContentFingerprint(text) {
    // Normalizza: lowercase + rimuovi whitespace multipli + trim
    const normalized = text
      .substring(0, this.config.contentSampleSize)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Trova duplicato esatto tramite hash file
   * 
   * @param {string} fileHash - SHA-256 hash
   * @param {string} db - Database
   * @returns {Promise<Object|null>}
   */
  async findExactDuplicate(fileHash, db) {
    try {
      const result = await this.pg.query(`
        SELECT 
          id,
          title,
          original_filename,
          doc_type,
          doc_date,
          folder_id,
          created_at,
          created_by,
          file_hash
        FROM archive_documents
        WHERE db = $1 
          AND file_hash = $2
          AND is_current_version = TRUE
          AND deleted_at IS NULL
        LIMIT 1
      `, [db, fileHash]);

      return result.rows.length > 0 ? result.rows[0] : null;

    } catch (error) {
      this.logger.error('[DEDUP] Exact duplicate search failed:', error);
      return null;
    }
  }

  /**
   * Trova duplicati fuzzy via embedding similarity
   * 
   * @param {string} text - Testo documento
   * @param {string} db - Database
   * @param {Object} metadata - Metadata per filtri
   * @returns {Promise<Array>}
   */
  async findFuzzyDuplicates(text, db, metadata = {}) {
    try {
      // 1. Genera embedding del testo (usa sample per performance)
      const sample = text.substring(0, 2000); // Primi 2000 caratteri
      
      const embeddingResponse = await this.ollama.embeddings({
        model: this.config.embeddingModel,
        prompt: sample,
      });

      const queryVector = embeddingResponse.embedding;

      // 2. Search Qdrant per documenti simili
      const searchResult = await this.qdrant.search(this.config.qdrantCollection, {
        vector: queryVector,
        filter: {
          must: [{ key: 'db', match: { value: db } }],
        },
        limit: 10, // Top 10 candidati
        with_payload: true,
        score_threshold: 0.85, // Soglia minima 85%
      });

      // 3. Aggrega per documento (chunk → doc)
      const docScores = new Map();

      searchResult.forEach(point => {
        const docId = point.payload.document_id;
        const existing = docScores.get(docId);

        if (!existing || point.score > existing.score) {
          docScores.set(docId, {
            document_id: docId,
            similarity: point.score,
            title: point.payload.title,
            doc_type: point.payload.doc_type,
            doc_date: point.payload.doc_date,
          });
        }
      });

      // 4. Arricchisci con dati PostgreSQL
      if (docScores.size === 0) return [];

      const docIds = Array.from(docScores.keys());
      const enriched = await this.enrichDocuments(docIds, db);

      return enriched
        .map(doc => ({
          ...doc,
          similarity: docScores.get(doc.id).similarity,
        }))
        .sort((a, b) => b.similarity - a.similarity);

    } catch (error) {
      this.logger.error('[DEDUP] Fuzzy duplicate search failed:', error);
      return [];
    }
  }

  /**
   * Trova duplicati per contenuto (filename + metadata matching)
   * 
   * @param {string} filename - Nome file
   * @param {Object} metadata - Metadata documento
   * @param {string} db - Database
   * @returns {Promise<Object|null>}
   */
  async findContentDuplicate(filename, metadata, db) {
    try {
      // Normalizza filename (rimuovi estensione, lowercase, trim)
      const normalizedFilename = filename
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .trim();

      // Query fuzzy su filename + doc_type + doc_date
      let query = `
        SELECT 
          id,
          title,
          original_filename,
          doc_type,
          doc_date,
          folder_id,
          similarity(LOWER(original_filename), $2) as filename_similarity
        FROM archive_documents
        WHERE db = $1 
          AND is_current_version = TRUE
          AND deleted_at IS NULL
      `;

      const params = [db, normalizedFilename];
      let paramIndex = 3;

      if (metadata.doc_type) {
        query += ` AND doc_type = $${paramIndex++}`;
        params.push(metadata.doc_type);
      }

      if (metadata.doc_date) {
        query += ` AND doc_date = $${paramIndex++}`;
        params.push(metadata.doc_date);
      }

      query += `
        ORDER BY filename_similarity DESC
        LIMIT 1
      `;

      const result = await this.pg.query(query, params);

      if (result.rows.length > 0 && result.rows[0].filename_similarity > 0.7) {
        return result.rows[0];
      }

      return null;

    } catch (error) {
      this.logger.error('[DEDUP] Content duplicate search failed:', error);
      return null;
    }
  }

  /**
   * Arricchisci documenti con metadata completi
   */
  async enrichDocuments(docIds, db) {
    if (docIds.length === 0) return [];

    const placeholders = docIds.map((_, i) => `$${i + 2}`).join(',');

    const query = `
      SELECT 
        id,
        title,
        original_filename,
        doc_type,
        doc_date,
        doc_sender,
        doc_recipient,
        folder_id,
        file_size_bytes,
        page_count,
        created_at,
        created_by
      FROM archive_documents
      WHERE db = $1 AND id = ANY($${docIds.length + 1})
    `;

    const result = await this.pg.query(query, [db, docIds]);
    return result.rows;
  }

  /**
   * Store file hash dopo upload
   * Da chiamare dopo successful upload
   * 
   * @param {string} documentId - ID documento
   * @param {string} fileHash - SHA-256 hash
   */
  async storeFileHash(documentId, fileHash) {
    try {
      await this.pg.query(`
        UPDATE archive_documents
        SET file_hash = $1
        WHERE id = $2
      `, [fileHash, documentId]);

      this.logger.info(`[DEDUP] Stored file hash for document: ${documentId}`);

    } catch (error) {
      this.logger.error(`[DEDUP] Failed to store hash for ${documentId}:`, error);
    }
  }

  /**
   * Trova tutti i duplicati nel database
   * Utility per cleanup batch
   * 
   * @param {string} db - Database
   * @param {Object} options - Opzioni
   * @returns {Promise<Array>}
   */
  async findAllDuplicates(db, options = {}) {
    const { includeNearDuplicates = false, limit = 100 } = options;

    try {
      // 1. Duplicati esatti (stesso hash)
      const exactDuplicates = await this.pg.query(`
        SELECT 
          file_hash,
          ARRAY_AGG(id ORDER BY created_at DESC) as document_ids,
          ARRAY_AGG(title ORDER BY created_at DESC) as titles,
          COUNT(*) as count
        FROM archive_documents
        WHERE db = $1 
          AND file_hash IS NOT NULL
          AND is_current_version = TRUE
          AND deleted_at IS NULL
        GROUP BY file_hash
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT $2
      `, [db, limit]);

      const results = {
        exact_duplicates: exactDuplicates.rows.map(row => ({
          type: DUPLICATE_TYPES.EXACT,
          file_hash: row.file_hash,
          document_ids: row.document_ids,
          titles: row.titles,
          count: parseInt(row.count),
          suggestion: `Keep: ${row.document_ids[0]}, Delete: ${row.document_ids.slice(1).join(', ')}`,
        })),
        near_duplicates: [],
      };

      // 2. Near duplicates (opzionale, costoso)
      if (includeNearDuplicates) {
        // TODO: Implementare scan completo con similarity check
        // Richiede scan di tutti i documenti - costoso per grandi dataset
        this.logger.warn('[DEDUP] Near duplicate scan not yet implemented for batch mode');
      }

      return results;

    } catch (error) {
      this.logger.error('[DEDUP] Find all duplicates failed:', error);
      throw error;
    }
  }

  /**
   * Risolvi duplicati automaticamente
   * Mantiene il più recente, soft-delete gli altri
   * 
   * @param {Array} duplicateGroups - Gruppi da findAllDuplicates
   * @param {Object} options - Opzioni
   * @returns {Promise<Object>}
   */
  async resolveDuplicates(duplicateGroups, options = {}) {
    const { dryRun = false, keepStrategy = 'newest' } = options;

    const results = {
      total_groups: duplicateGroups.length,
      total_documents_affected: 0,
      kept: [],
      deleted: [],
    };

    for (const group of duplicateGroups) {
      const docIds = group.document_ids;

      // Determina quale mantenere
      let keepIndex = 0;
      if (keepStrategy === 'oldest') {
        keepIndex = docIds.length - 1;
      }

      const keepId = docIds[keepIndex];
      const deleteIds = docIds.filter((_, i) => i !== keepIndex);

      results.kept.push(keepId);
      results.deleted.push(...deleteIds);
      results.total_documents_affected += deleteIds.length;

      if (!dryRun) {
        try {
          // Soft delete duplicati
          await this.pg.query(`
            UPDATE archive_documents
            SET deleted_at = NOW(),
                pipeline_status = 'duplicate_deleted'
            WHERE id = ANY($1)
          `, [deleteIds]);

          // Elimina chunk Qdrant associati
          for (const docId of deleteIds) {
            await this.qdrant.delete(this.config.qdrantCollection, {
              filter: {
                must: [{ key: 'document_id', match: { value: docId } }],
              },
            });
          }

          this.logger.info(`[DEDUP] Resolved duplicate group`, {
            kept: keepId,
            deleted: deleteIds,
          });

        } catch (error) {
          this.logger.error(`[DEDUP] Failed to resolve duplicate group`, error);
        }
      }
    }

    this.logger.info(`[DEDUP] Duplicate resolution completed`, results);

    return results;
  }
}

export default DeduplicationService;
