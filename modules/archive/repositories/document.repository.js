/**
 * Repository per documenti dell'archivio
 * Gestisce tutte le operazioni CRUD sulla tabella archive_documents
 */

export class DocumentRepository {
  constructor(pgClient) {
    this.pg = pgClient;
  }

  /**
   * Crea un nuovo documento
   */
  async create(documentData) {
    const {
      db,
      originalFilename,
      fileSize,
      mimeType,
      fileHash,
      storagePath,
      storageBucket = 'archive',
      folderPath,
      folderPathArray,
      parentFolder,
      tags,
      documentType,
      documentSubtype,
      title,
      description,
      documentDate,
      fiscalYear,
      relatedSubjectId,
      relatedCategoryId,
      relatedTransactionIds,
      priority = 'NORMAL',
      createdBy,
    } = documentData;

    const query = `
      INSERT INTO archive_documents (
        db, original_filename, file_size, mime_type, file_hash,
        storage_path, storage_bucket, folder_path, folder_path_array, 
        parent_folder, tags, document_type, document_subtype,
        title, description, document_date, fiscal_year,
        related_subject_id, related_category_id, related_transaction_ids,
        priority, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING *
    `;

    const values = [
      db,
      originalFilename,
      fileSize,
      mimeType,
      fileHash,
      storagePath,
      storageBucket,
      folderPath || '',
      folderPathArray || [],
      parentFolder,
      tags || [],
      documentType,
      documentSubtype,
      title,
      description,
      documentDate,
      fiscalYear,
      relatedSubjectId,
      relatedCategoryId,
      relatedTransactionIds,
      priority,
      createdBy,
    ];

    const result = await this.pg.query(query, values);
    return result.rows[0];
  }

  /**
   * Trova documento per ID
   */
  async findById(id) {
    const query = 'SELECT * FROM archive_documents WHERE id = $1 AND deleted_at IS NULL';
    const result = await this.pg.query(query, [id]);
    return result.rows[0];
  }

  /**
   * Trova documento per hash (deduplicazione)
   */
  async findByHash(fileHash) {
    const query = 'SELECT * FROM archive_documents WHERE file_hash = $1 AND deleted_at IS NULL';
    const result = await this.pg.query(query, [fileHash]);
    return result.rows[0];
  }

  /**
   * Trova documenti per database
   */
  async findByDatabase(db, options = {}) {
    const { limit = 50, offset = 0, status, priority, documentType } = options;

    let query = 'SELECT * FROM archive_documents WHERE db = $1 AND deleted_at IS NULL';
    const values = [db];
    let paramCount = 1;

    if (status) {
      paramCount++;
      query += ` AND processing_status = $${paramCount}`;
      values.push(status);
    }

    if (priority) {
      paramCount++;
      query += ` AND priority = $${paramCount}`;
      values.push(priority);
    }

    if (documentType) {
      paramCount++;
      query += ` AND document_type = $${paramCount}`;
      values.push(documentType);
    }

    query += ' ORDER BY created_at DESC';

    paramCount++;
    query += ` LIMIT $${paramCount}`;
    values.push(limit);

    paramCount++;
    query += ` OFFSET $${paramCount}`;
    values.push(offset);

    const result = await this.pg.query(query, values);
    return result.rows;
  }

  /**
   * Aggiorna stato di processamento
   */
  async updateProcessingStatus(id, status, errorMessage = null) {
    const query = `
      UPDATE archive_documents 
      SET processing_status = $1,
          error_message = $2,
          completed_at = CASE WHEN $1 = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id = $3
      RETURNING *
    `;
    const result = await this.pg.query(query, [status, errorMessage, id]);
    return result.rows[0];
  }

  /**
   * Aggiorna testo estratto
   */
  async updateExtractedText(id, extractedText, extractedMetadata = null) {
    const query = `
      UPDATE archive_documents 
      SET extracted_text = $1,
          extracted_metadata = $2
      WHERE id = $3
      RETURNING *
    `;
    const result = await this.pg.query(query, [extractedText, extractedMetadata, id]);
    return result.rows[0];
  }

  /**
   * Marca come duplicato
   */
  async markAsDuplicate(id, duplicateOfId, similarityScore = null) {
    const query = `
      UPDATE archive_documents 
      SET is_duplicate = true,
          duplicate_of = $1,
          similarity_score = $2
      WHERE id = $3
      RETURNING *
    `;
    const result = await this.pg.query(query, [duplicateOfId, similarityScore, id]);
    return result.rows[0];
  }

  /**
   * Ricerca full-text su contenuto estratto
   */
  async fullTextSearch(db, searchQuery, options = {}) {
    const { limit = 20, offset = 0 } = options;

    const query = `
      SELECT 
        *,
        ts_rank(to_tsvector('italian', COALESCE(extracted_text, '')), plainto_tsquery('italian', $2)) AS rank
      FROM archive_documents
      WHERE db = $1 
        AND deleted_at IS NULL
        AND to_tsvector('italian', COALESCE(extracted_text, '')) @@ plainto_tsquery('italian', $2)
      ORDER BY rank DESC
      LIMIT $3 OFFSET $4
    `;

    const result = await this.pg.query(query, [db, searchQuery, limit, offset]);
    return result.rows;
  }

  /**
   * Ricerca fuzzy per similarità su filename/title
   */
  async fuzzySearch(db, searchTerm, options = {}) {
    const { limit = 20, threshold = 0.3 } = options;

    const query = `
      SELECT 
        *,
        GREATEST(
          similarity(original_filename, $2),
          similarity(COALESCE(title, ''), $2)
        ) AS similarity_score
      FROM archive_documents
      WHERE db = $1 
        AND deleted_at IS NULL
        AND (
          similarity(original_filename, $2) > $3
          OR similarity(COALESCE(title, ''), $2) > $3
        )
      ORDER BY similarity_score DESC
      LIMIT $4
    `;

    const result = await this.pg.query(query, [db, searchTerm, threshold, limit]);
    return result.rows;
  }

  /**
   * Conta documenti per database
   */
  async countByDatabase(db, filters = {}) {
    let query = 'SELECT COUNT(*) FROM archive_documents WHERE db = $1 AND deleted_at IS NULL';
    const values = [db];
    let paramCount = 1;

    if (filters.status) {
      paramCount++;
      query += ` AND processing_status = $${paramCount}`;
      values.push(filters.status);
    }

    if (filters.documentType) {
      paramCount++;
      query += ` AND document_type = $${paramCount}`;
      values.push(filters.documentType);
    }

    const result = await this.pg.query(query, values);
    return parseInt(result.rows[0].count);
  }

  /**
   * Soft delete
   */
  async softDelete(id, deletedBy) {
    const query = `
      UPDATE archive_documents 
      SET deleted_at = CURRENT_TIMESTAMP,
          deleted_by = $1
      WHERE id = $2
      RETURNING *
    `;
    const result = await this.pg.query(query, [deletedBy, id]);
    return result.rows[0];
  }

  /**
   * Trova documenti in coda per processamento
   */
  async findPendingForProcessing(status, limit = 10) {
    const query = `
      SELECT * FROM archive_documents
      WHERE processing_status = $1
        AND deleted_at IS NULL
      ORDER BY 
        CASE priority
          WHEN 'URGENT' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'NORMAL' THEN 3
          WHEN 'LOW' THEN 4
          WHEN 'BATCH' THEN 5
        END,
        created_at ASC
      LIMIT $2
    `;
    const result = await this.pg.query(query, [status, limit]);
    return result.rows;
  }

  /**
   * Incrementa retry count
   */
  async incrementRetryCount(id) {
    const query = `
      UPDATE archive_documents 
      SET retry_count = retry_count + 1,
          last_retry_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pg.query(query, [id]);
    return result.rows[0];
  }
}

export default DocumentRepository;
