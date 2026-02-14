/**
 * Repository per chunks dei documenti
 * Gestisce tutte le operazioni CRUD sulla tabella archive_chunks
 */

export class ChunkRepository {
  constructor(pgClient) {
    this.pg = pgClient;
  }

  /**
   * Crea un nuovo chunk
   */
  async create(chunkData) {
    const {
      documentId,
      chunkText,
      chunkOrder,
      chunkType = 'generic',
      charStart,
      charEnd,
      pageNumber,
      qdrantId,
      qdrantCollection = 'archive_documents',
      embeddingModel = 'nomic-embed-text',
      embeddingDimensions = 768,
      chunkMetadata,
    } = chunkData;

    const query = `
      INSERT INTO archive_chunks (
        document_id, chunk_text, chunk_order, chunk_type,
        char_start, char_end, page_number,
        qdrant_id, qdrant_collection, embedding_model, embedding_dimensions,
        chunk_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const values = [
      documentId,
      chunkText,
      chunkOrder,
      chunkType,
      charStart,
      charEnd,
      pageNumber,
      qdrantId,
      qdrantCollection,
      embeddingModel,
      embeddingDimensions,
      chunkMetadata,
    ];

    const result = await this.pg.query(query, values);
    return result.rows[0];
  }

  /**
   * Crea chunks in batch
   */
  async createBatch(chunks) {
    if (!chunks || chunks.length === 0) return [];

    const values = [];
    const placeholders = [];
    let paramCount = 0;

    chunks.forEach((chunk, index) => {
      const placeholderGroup = [];
      for (let i = 0; i < 12; i++) {
        placeholderGroup.push(`$${++paramCount}`);
      }
      placeholders.push(`(${placeholderGroup.join(', ')})`);

      values.push(
        chunk.documentId,
        chunk.chunkText,
        chunk.chunkOrder,
        chunk.chunkType || 'generic',
        chunk.charStart,
        chunk.charEnd,
        chunk.pageNumber,
        chunk.qdrantId,
        chunk.qdrantCollection || 'archive_documents',
        chunk.embeddingModel || 'nomic-embed-text',
        chunk.embeddingDimensions || 768,
        chunk.chunkMetadata
      );
    });

    const query = `
      INSERT INTO archive_chunks (
        document_id, chunk_text, chunk_order, chunk_type,
        char_start, char_end, page_number,
        qdrant_id, qdrant_collection, embedding_model, embedding_dimensions,
        chunk_metadata
      ) VALUES ${placeholders.join(', ')}
      RETURNING *
    `;

    const result = await this.pg.query(query, values);
    return result.rows;
  }

  /**
   * Trova chunk per ID
   */
  async findById(id) {
    const query = 'SELECT * FROM archive_chunks WHERE id = $1';
    const result = await this.pg.query(query, [id]);
    return result.rows[0];
  }

  /**
   * Trova chunks per documento
   */
  async findByDocumentId(documentId) {
    const query = 'SELECT * FROM archive_chunks WHERE document_id = $1 ORDER BY chunk_order ASC';
    const result = await this.pg.query(query, [documentId]);
    return result.rows;
  }

  /**
   * Trova chunk per Qdrant ID
   */
  async findByQdrantId(qdrantId) {
    const query = 'SELECT * FROM archive_chunks WHERE qdrant_id = $1';
    const result = await this.pg.query(query, [qdrantId]);
    return result.rows[0];
  }

  /**
   * Aggiorna stato sync con Qdrant
   */
  async updateQdrantSyncStatus(id, synced, errorMessage = null) {
    const query = `
      UPDATE archive_chunks 
      SET synced_to_qdrant = $1,
          qdrant_sync_at = CASE WHEN $1 = true THEN CURRENT_TIMESTAMP ELSE qdrant_sync_at END,
          qdrant_sync_error = $2
      WHERE id = $3
      RETURNING *
    `;
    const result = await this.pg.query(query, [synced, errorMessage, id]);
    return result.rows[0];
  }

  /**
   * Marca multipli chunks come sincronizzati con Qdrant
   */
  async markBatchAsSynced(chunkIds) {
    if (!chunkIds || chunkIds.length === 0) return [];

    const query = `
      UPDATE archive_chunks 
      SET synced_to_qdrant = true,
          qdrant_sync_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1::uuid[])
      RETURNING *
    `;
    const result = await this.pg.query(query, [chunkIds]);
    return result.rows;
  }

  /**
   * Trova chunks non sincronizzati con Qdrant
   */
  async findUnsyncedChunks(limit = 100) {
    const query = `
      SELECT * FROM archive_chunks
      WHERE synced_to_qdrant = false
      ORDER BY created_at ASC
      LIMIT $1
    `;
    const result = await this.pg.query(query, [limit]);
    return result.rows;
  }

  /**
   * Ricerca full-text su chunks
   */
  async fullTextSearch(searchQuery, options = {}) {
    const { limit = 20, offset = 0 } = options;

    const query = `
      SELECT 
        c.*,
        d.original_filename,
        d.document_type,
        d.title,
        ts_rank(to_tsvector('italian', c.chunk_text), plainto_tsquery('italian', $1)) AS rank
      FROM archive_chunks c
      JOIN archive_documents d ON c.document_id = d.id
      WHERE to_tsvector('italian', c.chunk_text) @@ plainto_tsquery('italian', $1)
        AND d.deleted_at IS NULL
      ORDER BY rank DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await this.pg.query(query, [searchQuery, limit, offset]);
    return result.rows;
  }

  /**
   * Conta chunks per documento
   */
  async countByDocumentId(documentId) {
    const query = 'SELECT COUNT(*) FROM archive_chunks WHERE document_id = $1';
    const result = await this.pg.query(query, [documentId]);
    return parseInt(result.rows[0].count);
  }

  /**
   * Elimina tutti i chunks di un documento
   */
  async deleteByDocumentId(documentId) {
    const query = 'DELETE FROM archive_chunks WHERE document_id = $1 RETURNING *';
    const result = await this.pg.query(query, [documentId]);
    return result.rows;
  }

  /**
   * Trova chunks orphan (senza documento associato)
   * Utile per reconciliation
   */
  async findOrphanChunks(limit = 100) {
    const query = `
      SELECT c.*
      FROM archive_chunks c
      LEFT JOIN archive_documents d ON c.document_id = d.id
      WHERE d.id IS NULL
      LIMIT $1
    `;
    const result = await this.pg.query(query, [limit]);
    return result.rows;
  }

  /**
   * Trova chunks con Qdrant ID ma non sincronizzati
   * Utile per reconciliation
   */
  async findInconsistentSyncStatus(limit = 100) {
    const query = `
      SELECT * FROM archive_chunks
      WHERE qdrant_id IS NOT NULL 
        AND synced_to_qdrant = false
      LIMIT $1
    `;
    const result = await this.pg.query(query, [limit]);
    return result.rows;
  }

  /**
   * Aggiorna Qdrant ID
   */
  async updateQdrantId(id, qdrantId) {
    const query = `
      UPDATE archive_chunks 
      SET qdrant_id = $1
      WHERE id = $2
      RETURNING *
    `;
    const result = await this.pg.query(query, [qdrantId, id]);
    return result.rows[0];
  }

  /**
   * Statistiche chunks per tipo
   */
  async getChunkTypeStats(documentId) {
    const query = `
      SELECT 
        chunk_type,
        COUNT(*) as count,
        AVG(LENGTH(chunk_text)) as avg_length
      FROM archive_chunks
      WHERE document_id = $1
      GROUP BY chunk_type
      ORDER BY count DESC
    `;
    const result = await this.pg.query(query, [documentId]);
    return result.rows;
  }
}

export default ChunkRepository;
