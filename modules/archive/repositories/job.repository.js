/**
 * Repository per job di processamento
 * Gestisce tutte le operazioni CRUD sulla tabella archive_processing_jobs
 */

export class JobRepository {
  constructor(pgClient) {
    this.pg = pgClient;
  }

  /**
   * Crea un nuovo job
   */
  async create(jobData) {
    const {
      documentId,
      jobType,
      priority = 'NORMAL',
      jobPayload,
      maxRetries = 3,
      pgbossJobId,
    } = jobData;

    const query = `
      INSERT INTO archive_processing_jobs (
        document_id, job_type, priority, job_payload, max_retries, pgboss_job_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;

    const values = [documentId, jobType, priority, jobPayload, maxRetries, pgbossJobId];

    const result = await this.pg.query(query, values);
    return result.rows[0];
  }

  /**
   * Trova job per ID
   */
  async findById(id) {
    const query = 'SELECT * FROM archive_processing_jobs WHERE id = $1';
    const result = await this.pg.query(query, [id]);
    return result.rows[0];
  }

  /**
   * Trova jobs per documento
   */
  async findByDocumentId(documentId) {
    const query = `
      SELECT * FROM archive_processing_jobs 
      WHERE document_id = $1 
      ORDER BY queued_at DESC
    `;
    const result = await this.pg.query(query, [documentId]);
    return result.rows;
  }

  /**
   * Trova job per pg-boss ID
   */
  async findByPgBossJobId(pgbossJobId) {
    const query = 'SELECT * FROM archive_processing_jobs WHERE pgboss_job_id = $1';
    const result = await this.pg.query(query, [pgbossJobId]);
    return result.rows[0];
  }

  /**
   * Aggiorna stato job a "running"
   */
  async markAsRunning(id, workerId) {
    const query = `
      UPDATE archive_processing_jobs 
      SET job_status = 'running',
          started_at = CURRENT_TIMESTAMP,
          worker_id = $2
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pg.query(query, [id, workerId]);
    return result.rows[0];
  }

  /**
   * Aggiorna stato job a "completed"
   */
  async markAsCompleted(id, jobResult = null) {
    const query = `
      UPDATE archive_processing_jobs 
      SET job_status = 'completed',
          completed_at = CURRENT_TIMESTAMP,
          job_result = $2
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pg.query(query, [id, jobResult]);
    return result.rows[0];
  }

  /**
   * Aggiorna stato job a "failed"
   */
  async markAsFailed(id, errorMessage, errorStack = null) {
    const query = `
      UPDATE archive_processing_jobs 
      SET job_status = 'failed',
          completed_at = CURRENT_TIMESTAMP,
          error_message = $2,
          error_stack = $3,
          retry_count = retry_count + 1
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pg.query(query, [id, errorMessage, errorStack]);
    return result.rows[0];
  }

  /**
   * Cancella job
   */
  async cancel(id) {
    const query = `
      UPDATE archive_processing_jobs 
      SET job_status = 'cancelled',
          completed_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pg.query(query, [id]);
    return result.rows[0];
  }

  /**
   * Trova jobs in coda (ordinati per priorità)
   */
  async findQueuedJobs(jobType = null, limit = 10) {
    let query = `
      SELECT * FROM archive_processing_jobs 
      WHERE job_status = 'queued'
    `;
    const values = [];

    if (jobType) {
      query += ' AND job_type = $1';
      values.push(jobType);
    }

    query += `
      ORDER BY 
        CASE priority
          WHEN 'URGENT' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'NORMAL' THEN 3
          WHEN 'LOW' THEN 4
          WHEN 'BATCH' THEN 5
        END,
        queued_at ASC
      LIMIT $${values.length + 1}
    `;
    values.push(limit);

    const result = await this.pg.query(query, values);
    return result.rows;
  }

  /**
   * Trova jobs falliti con retry disponibili
   */
  async findRetryableJobs(limit = 10) {
    const query = `
      SELECT * FROM archive_processing_jobs 
      WHERE job_status = 'failed'
        AND retry_count < max_retries
      ORDER BY queued_at ASC
      LIMIT $1
    `;
    const result = await this.pg.query(query, [limit]);
    return result.rows;
  }

  /**
   * Statistiche jobs
   */
  async getJobStats(filters = {}) {
    let query = `
      SELECT 
        job_type,
        job_status,
        COUNT(*) as count,
        AVG(duration_ms) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        MIN(duration_ms) as min_duration_ms
      FROM archive_processing_jobs
      WHERE 1=1
    `;
    const values = [];
    let paramCount = 0;

    if (filters.jobType) {
      paramCount++;
      query += ` AND job_type = $${paramCount}`;
      values.push(filters.jobType);
    }

    if (filters.fromDate) {
      paramCount++;
      query += ` AND queued_at >= $${paramCount}`;
      values.push(filters.fromDate);
    }

    if (filters.toDate) {
      paramCount++;
      query += ` AND queued_at <= $${paramCount}`;
      values.push(filters.toDate);
    }

    query += ' GROUP BY job_type, job_status ORDER BY job_type, job_status';

    const result = await this.pg.query(query, values);
    return result.rows;
  }

  /**
   * Conta jobs per stato
   */
  async countByStatus(jobType = null) {
    let query = `
      SELECT job_status, COUNT(*) as count
      FROM archive_processing_jobs
    `;
    const values = [];

    if (jobType) {
      query += ' WHERE job_type = $1';
      values.push(jobType);
    }

    query += ' GROUP BY job_status';

    const result = await this.pg.query(query, values);
    return result.rows.reduce((acc, row) => {
      acc[row.job_status] = parseInt(row.count);
      return acc;
    }, {});
  }

  /**
   * Trova ultimo job completato per documento
   */
  async findLastCompletedByDocument(documentId, jobType) {
    const query = `
      SELECT * FROM archive_processing_jobs 
      WHERE document_id = $1 
        AND job_type = $2
        AND job_status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `;
    const result = await this.pg.query(query, [documentId, jobType]);
    return result.rows[0];
  }

  /**
   * Elimina vecchi jobs completati (cleanup)
   */
  async deleteOldCompletedJobs(daysOld = 30) {
    const query = `
      DELETE FROM archive_processing_jobs 
      WHERE job_status IN ('completed', 'cancelled')
        AND completed_at < NOW() - INTERVAL '${daysOld} days'
      RETURNING id
    `;
    const result = await this.pg.query(query);
    return result.rows;
  }

  /**
   * Trova jobs stuck (in running da troppo tempo)
   */
  async findStuckJobs(minutesThreshold = 30) {
    const query = `
      SELECT * FROM archive_processing_jobs 
      WHERE job_status = 'running'
        AND started_at < NOW() - INTERVAL '${minutesThreshold} minutes'
      ORDER BY started_at ASC
    `;
    const result = await this.pg.query(query);
    return result.rows;
  }

  /**
   * Reset job stuck a queued per retry
   */
  async resetStuckJob(id) {
    const query = `
      UPDATE archive_processing_jobs 
      SET job_status = 'queued',
          started_at = NULL,
          worker_id = NULL,
          retry_count = retry_count + 1
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pg.query(query, [id]);
    return result.rows[0];
  }
}

export default JobRepository;
