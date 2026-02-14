/**
 * Hybrid Search Service
 * 
 * Combina full-text search (PostgreSQL tsvector) con semantic search (Qdrant)
 * usando Reciprocal Rank Fusion (RRF) per il ranking finale.
 * 
 * @module archive/services/hybrid-search
 */

import { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Reciprocal Rank Fusion (RRF)
 * 
 * Formula: RRF(d) = Σ 1 / (k + rank(d))
 * dove k = 60 (costante standard), rank(d) = posizione del documento nella lista
 * 
 * Vantaggi RRF:
 * - Non richiede normalizzazione score (gestisce scale diverse)
 * - Penalizza meno i documenti con rank basso
 * - Robusto contro outlier
 * 
 * @param {Array} rankedLists - Array di liste rankate: [{ id, score, source }, ...]
 * @param {number} k - Costante RRF (default: 60)
 * @returns {Array} Lista unificata ordinata per RRF score
 */
function reciprocalRankFusion(rankedLists, k = 60) {
  const rrfScores = new Map();

  rankedLists.forEach((list, listIndex) => {
    list.forEach((item, rank) => {
      const docId = item.document_id || item.id;
      const currentScore = rrfScores.get(docId) || { id: docId, rrfScore: 0, sources: [] };

      // RRF formula: 1 / (k + rank+1)
      // rank+1 perché rank è 0-indexed ma la formula usa 1-indexed
      const rrfContribution = 1 / (k + rank + 1);

      currentScore.rrfScore += rrfContribution;
      currentScore.sources.push({
        source: item.source || `list_${listIndex}`,
        rank: rank + 1,
        originalScore: item.score,
        rrfContribution,
      });

      // Mantieni metadata del primo match
      if (!currentScore.metadata) {
        currentScore.metadata = item.metadata || {};
      }

      rrfScores.set(docId, currentScore);
    });
  });

  // Converti Map in array e ordina per RRF score decrescente
  return Array.from(rrfScores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Normalizza score con min-max scaling
 * Usato come alternativa a RRF quando si vuole weighted fusion
 * 
 * @param {Array} results - Lista con score
 * @returns {Array} Lista con score normalizzati [0,1]
 */
function minMaxNormalize(results) {
  if (results.length === 0) return results;

  const scores = results.map(r => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;

  if (range === 0) {
    return results.map(r => ({ ...r, normalizedScore: 1 }));
  }

  return results.map(r => ({
    ...r,
    normalizedScore: (r.score - min) / range,
  }));
}

/**
 * Weighted Fusion (alternativa a RRF)
 * Combina score normalizzati con pesi configurabili
 * 
 * @param {Object} fullTextResults - Risultati PostgreSQL
 * @param {Object} semanticResults - Risultati Qdrant
 * @param {Object} weights - { fullText: 0.4, semantic: 0.6 }
 * @returns {Array} Risultati fusi e ordinati
 */
function weightedFusion(fullTextResults, semanticResults, weights = { fullText: 0.4, semantic: 0.6 }) {
  const normalizedFT = minMaxNormalize(fullTextResults);
  const normalizedSem = minMaxNormalize(semanticResults);

  const combinedScores = new Map();

  normalizedFT.forEach(item => {
    combinedScores.set(item.id, {
      id: item.id,
      score: item.normalizedScore * weights.fullText,
      ftScore: item.normalizedScore,
      semScore: 0,
      metadata: item.metadata,
    });
  });

  normalizedSem.forEach(item => {
    const existing = combinedScores.get(item.document_id);
    if (existing) {
      existing.score += item.normalizedScore * weights.semantic;
      existing.semScore = item.normalizedScore;
    } else {
      combinedScores.set(item.document_id, {
        id: item.document_id,
        score: item.normalizedScore * weights.semantic,
        ftScore: 0,
        semScore: item.normalizedScore,
        metadata: item.payload,
      });
    }
  });

  return Array.from(combinedScores.values())
    .sort((a, b) => b.score - a.score);
}

/**
 * Hybrid Search Service Class
 */
export class HybridSearchService {
  constructor({ pgPool, qdrantClient, ollamaClient, config = {} }) {
    this.pg = pgPool;
    this.qdrant = qdrantClient;
    this.ollama = ollamaClient;

    // Configurazione
    this.config = {
      qdrantCollection: config.qdrantCollection || 'archive_document_chunks',
      embeddingModel: config.embeddingModel || 'bge-m3',
      fusionMethod: config.fusionMethod || 'rrf', // 'rrf' | 'weighted'
      rrfConstant: config.rrfConstant || 60,
      weights: config.weights || { fullText: 0.4, semantic: 0.6 },
      topK: config.topK || 20, // Recupera top 20 per fonte prima di fondere
    };
  }

  /**
   * Full-Text Search su PostgreSQL
   * Usa ts_rank per ranking rilevanza
   * 
   * @param {string} query - Query di ricerca
   * @param {Object} filters - Filtri aggiuntivi
   * @param {number} limit - Numero risultati
   * @returns {Promise<Array>}
   */
  async fullTextSearch(query, filters = {}, limit = 20) {
    const { db, folder_id, doc_type, date_from, date_to } = filters;

    // Costruisci tsquery (gestisce italiano)
    const tsquery = query
      .trim()
      .split(/\s+/)
      .map(word => `${word}:*`)  // Prefix matching
      .join(' & ');

    let sqlQuery = `
      SELECT 
        id,
        title,
        doc_type,
        doc_date,
        doc_sender,
        doc_recipient,
        folder_id,
        ts_rank(search_vector, to_tsquery('italian', $1)) as score,
        ts_headline('italian', 
          COALESCE(cleaned_text, extracted_text), 
          to_tsquery('italian', $1),
          'MaxWords=50, MinWords=20, MaxFragments=2'
        ) as snippet
      FROM archive_documents
      WHERE 
        db = $2
        AND is_current_version = TRUE
        AND deleted_at IS NULL
        AND pipeline_status = 'indexed'
        AND search_vector @@ to_tsquery('italian', $1)
    `;

    const params = [tsquery, db];
    let paramIndex = 3;

    if (folder_id) {
      sqlQuery += ` AND folder_id = $${paramIndex++}`;
      params.push(folder_id);
    }

    if (doc_type) {
      sqlQuery += ` AND doc_type = $${paramIndex++}`;
      params.push(doc_type);
    }

    if (date_from) {
      sqlQuery += ` AND doc_date >= $${paramIndex++}`;
      params.push(date_from);
    }

    if (date_to) {
      sqlQuery += ` AND doc_date <= $${paramIndex++}`;
      params.push(date_to);
    }

    sqlQuery += `
      ORDER BY score DESC
      LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await this.pg.query(sqlQuery, params);

    return result.rows.map(row => ({
      id: row.id,
      score: parseFloat(row.score),
      source: 'fulltext',
      metadata: {
        title: row.title,
        doc_type: row.doc_type,
        doc_date: row.doc_date,
        doc_sender: row.doc_sender,
        doc_recipient: row.doc_recipient,
        folder_id: row.folder_id,
        snippet: row.snippet,
      },
    }));
  }

  /**
   * Semantic Search su Qdrant
   * Usa cosine similarity su embeddings
   * 
   * @param {string} query - Query di ricerca
   * @param {Object} filters - Filtri aggiuntivi
   * @param {number} limit - Numero risultati
   * @returns {Promise<Array>}
   */
  async semanticSearch(query, filters = {}, limit = 20) {
    const { db, folder_id, doc_type, date_from, date_to } = filters;

    // 1. Genera embedding della query
    const embeddingResponse = await this.ollama.embeddings({
      model: this.config.embeddingModel,
      prompt: query,
    });

    const queryVector = embeddingResponse.embedding;

    // 2. Costruisci filtri Qdrant
    const must = [
      { key: 'db', match: { value: db } },
    ];

    if (folder_id) {
      must.push({ key: 'folder_id', match: { value: folder_id } });
    }

    if (doc_type) {
      must.push({ key: 'doc_type', match: { value: doc_type } });
    }

    if (date_from) {
      must.push({ 
        key: 'doc_date', 
        range: { gte: new Date(date_from).toISOString() } 
      });
    }

    if (date_to) {
      must.push({ 
        key: 'doc_date', 
        range: { lte: new Date(date_to).toISOString() } 
      });
    }

    // 3. Search Qdrant
    const searchResult = await this.qdrant.search(this.config.qdrantCollection, {
      vector: queryVector,
      filter: { must },
      limit,
      with_payload: true,
    });

    // 4. Aggrega risultati per documento (chunk → doc)
    const docScores = new Map();

    searchResult.forEach(point => {
      const docId = point.payload.document_id;
      const existing = docScores.get(docId);

      if (!existing || point.score > existing.score) {
        // Mantieni il chunk con score più alto per documento
        docScores.set(docId, {
          document_id: docId,
          score: point.score,
          source: 'semantic',
          chunk_text: point.payload.chunk_text,
          chunk_index: point.payload.chunk_index,
          page_start: point.payload.page_start,
          metadata: {
            title: point.payload.title,
            doc_type: point.payload.doc_type,
            doc_date: point.payload.doc_date,
            doc_sender: point.payload.doc_sender,
            folder_id: point.payload.folder_id,
          },
        });
      }
    });

    return Array.from(docScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Hybrid Search Principale
   * Combina full-text e semantic search con RRF
   * 
   * @param {string} query - Query di ricerca
   * @param {Object} options - Opzioni di ricerca
   * @returns {Promise<Object>}
   */
  async search(query, options = {}) {
    const {
      db,
      filters = {},
      limit = 10,
      offset = 0,
      fusionMethod = this.config.fusionMethod,
      includeMetrics = false,
    } = options;

    const startTime = Date.now();

    // 1. Esegui ricerche in parallelo
    const [fullTextResults, semanticResults] = await Promise.all([
      this.fullTextSearch(query, { db, ...filters }, this.config.topK),
      this.semanticSearch(query, { db, ...filters }, this.config.topK),
    ]);

    // 2. Fusi risultati
    let fusedResults;
    if (fusionMethod === 'weighted') {
      fusedResults = weightedFusion(fullTextResults, semanticResults, this.config.weights);
    } else {
      // RRF (default)
      fusedResults = reciprocalRankFusion(
        [fullTextResults, semanticResults],
        this.config.rrfConstant
      );
    }

    // 3. Paginazione
    const paginatedResults = fusedResults.slice(offset, offset + limit);

    // 4. Arricchisci con metadati completi da PostgreSQL
    const docIds = paginatedResults.map(r => r.id);
    const enrichedResults = await this.enrichDocuments(docIds, db);

    // Merge score e source info
    const finalResults = paginatedResults.map(result => {
      const doc = enrichedResults.find(d => d.id === result.id);
      return {
        ...doc,
        relevance_score: result.rrfScore || result.score,
        sources: result.sources || [],
        snippet: result.metadata?.snippet || doc.snippet,
      };
    });

    const response = {
      query,
      total: fusedResults.length,
      limit,
      offset,
      results: finalResults,
    };

    if (includeMetrics) {
      response.metrics = {
        total_time_ms: Date.now() - startTime,
        fulltext_count: fullTextResults.length,
        semantic_count: semanticResults.length,
        fusion_method: fusionMethod,
      };
    }

    return response;
  }

  /**
   * Arricchisce documenti con metadata completi da PostgreSQL
   * 
   * @param {Array} docIds - ID documenti
   * @param {string} db - Database
   * @returns {Promise<Array>}
   */
  async enrichDocuments(docIds, db) {
    if (docIds.length === 0) return [];

    const placeholders = docIds.map((_, i) => `$${i + 2}`).join(',');

    const query = `
      SELECT 
        d.id,
        d.title,
        d.original_filename,
        d.doc_type,
        d.doc_date,
        d.doc_sender,
        d.doc_recipient,
        d.doc_amount,
        d.doc_protocol,
        d.page_count,
        d.file_size_bytes,
        d.folder_id,
        d.pipeline_status,
        d.created_at,
        f.name as folder_name,
        f.path as folder_path,
        ARRAY_AGG(DISTINCT t.tag) FILTER (WHERE t.tag IS NOT NULL) as tags,
        COALESCE(
          ts_headline('italian', 
            d.cleaned_text, 
            plainto_tsquery('italian', ''),
            'MaxWords=100, MinWords=30'
          ),
          LEFT(d.cleaned_text, 500)
        ) as snippet
      FROM archive_documents d
      LEFT JOIN archive_folders f ON f.id = d.folder_id
      LEFT JOIN archive_document_tags t ON t.document_id = d.id
      WHERE d.db = $1 AND d.id = ANY($${docIds.length + 1})
      GROUP BY d.id, f.name, f.path
    `;

    const result = await this.pg.query(query, [db, docIds]);

    return result.rows.map(row => ({
      id: row.id,
      title: row.title,
      filename: row.original_filename,
      type: row.doc_type,
      date: row.doc_date,
      sender: row.doc_sender,
      recipient: row.doc_recipient,
      amount: row.doc_amount ? parseFloat(row.doc_amount) : null,
      protocol: row.doc_protocol,
      page_count: row.page_count,
      file_size: row.file_size_bytes,
      folder: row.folder_id ? {
        id: row.folder_id,
        name: row.folder_name,
        path: row.folder_path,
      } : null,
      tags: row.tags || [],
      status: row.pipeline_status,
      created_at: row.created_at,
      snippet: row.snippet,
    }));
  }
}

export default HybridSearchService;
