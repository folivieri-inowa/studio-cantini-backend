/**
 * Priority Queue Service
 * 
 * Gestisce code con priorità per processamento documenti.
 * Permette di saltare la coda FIFO per documenti urgenti.
 * 
 * Estende pg-boss con logica di priorità custom.
 * 
 * @module archive/services/priority-queue
 */

/**
 * Livelli di priorità
 */
export const PRIORITY_LEVELS = {
  URGENT: { value: 100, label: 'Urgente', maxWait: 60 * 1000 },         // Max 1 minuto
  HIGH: { value: 75, label: 'Alta', maxWait: 5 * 60 * 1000 },          // Max 5 minuti
  NORMAL: { value: 50, label: 'Normale', maxWait: 30 * 60 * 1000 },    // Max 30 minuti
  LOW: { value: 25, label: 'Bassa', maxWait: 120 * 60 * 1000 },        // Max 2 ore
  BATCH: { value: 10, label: 'Batch', maxWait: null },                  // Nessun limite
};

/**
 * Priority Queue Service
 * Wrapper sopra pg-boss con gestione priorità
 */
export class PriorityQueueService {
  constructor({ pgBoss, logger, config = {} }) {
    this.pgBoss = pgBoss;
    this.logger = logger;

    this.config = {
      enableStarvationPrevention: config.enableStarvationPrevention !== undefined 
        ? config.enableStarvationPrevention 
        : true,
      starvationThresholdMs: config.starvationThresholdMs || 60 * 60 * 1000, // 1 ora
      monitoringInterval: config.monitoringInterval || 5 * 60 * 1000,         // 5 minuti
    };

    // Metriche interne
    this.metrics = {
      totalEnqueued: 0,
      processedByPriority: {},
      averageWaitTime: {},
    };

    // Inizializza metriche per ogni priorità
    Object.keys(PRIORITY_LEVELS).forEach(key => {
      this.metrics.processedByPriority[key] = 0;
      this.metrics.averageWaitTime[key] = 0;
    });
  }

  /**
   * Enqueue documento con priorità
   * 
   * @param {string} jobType - Tipo job ('archive-ocr', 'archive-embed', etc.)
   * @param {Object} data - Dati job
   * @param {Object} options - Opzioni aggiuntive
   * @returns {Promise<string>} Job ID
   */
  async enqueue(jobType, data, options = {}) {
    const {
      priority = 'NORMAL',
      metadata = {},
      startAfter = null,
      retryLimit = 3,
      retryDelay = 30,
      retryBackoff = true,
      expireInHours = 24,
    } = options;

    // Valida priorità
    if (!PRIORITY_LEVELS[priority]) {
      throw new Error(`Invalid priority: ${priority}. Must be one of: ${Object.keys(PRIORITY_LEVELS).join(', ')}`);
    }

    const priorityConfig = PRIORITY_LEVELS[priority];

    // Costruisci opzioni pg-boss
    const pgBossOptions = {
      priority: priorityConfig.value,
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInHours,
      startAfter: startAfter || (priority === 'BATCH' ? new Date(Date.now() + 10000) : null), // Batch ritardato 10sec
    };

    // Aggiungi metadata per tracking
    const enhancedData = {
      ...data,
      _priority: priority,
      _enqueuedAt: new Date().toISOString(),
      _metadata: metadata,
    };

    try {
      const jobId = await this.pgBoss.send(jobType, enhancedData, pgBossOptions);

      // Aggiorna metriche
      this.metrics.totalEnqueued++;
      
      this.logger.info(`[PRIORITY_QUEUE] Job enqueued`, {
        jobId,
        jobType,
        priority,
        priorityValue: priorityConfig.value,
      });

      return jobId;

    } catch (error) {
      this.logger.error(`[PRIORITY_QUEUE] Failed to enqueue job`, {
        jobType,
        priority,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Enqueue OCR con priorità
   * Shortcut per job OCR frequenti
   */
  async enqueueOcr(documentId, db, options = {}) {
    return this.enqueue('archive-ocr', { documentId, db }, options);
  }

  /**
   * Enqueue Embedding con priorità
   */
  async enqueueEmbedding(documentId, db, options = {}) {
    return this.enqueue('archive-embed', { documentId, db }, options);
  }

  /**
   * Batch Enqueue
   * Accoda multipli documenti con stessa priorità
   * 
   * @param {string} jobType
   * @param {Array} dataArray - Array di data objects
   * @param {Object} options - Opzioni comuni
   * @returns {Promise<Array>} Array di job IDs
   */
  async enqueueBatch(jobType, dataArray, options = {}) {
    const { priority = 'BATCH', ...rest } = options;

    const jobs = dataArray.map(data => ({
      name: jobType,
      data: {
        ...data,
        _priority: priority,
        _enqueuedAt: new Date().toISOString(),
      },
      options: {
        priority: PRIORITY_LEVELS[priority].value,
        ...rest,
      },
    }));

    try {
      const jobIds = await this.pgBoss.insert(jobs);

      this.metrics.totalEnqueued += jobIds.length;

      this.logger.info(`[PRIORITY_QUEUE] Batch enqueued`, {
        jobType,
        count: jobIds.length,
        priority,
      });

      return jobIds;

    } catch (error) {
      this.logger.error(`[PRIORITY_QUEUE] Batch enqueue failed`, {
        jobType,
        count: dataArray.length,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Promuovi priorità job esistente
   * Utile per escalation manuale
   * 
   * @param {string} jobId - ID job
   * @param {string} newPriority - Nuova priorità
   */
  async promoteJob(jobId, newPriority) {
    if (!PRIORITY_LEVELS[newPriority]) {
      throw new Error(`Invalid priority: ${newPriority}`);
    }

    try {
      // pg-boss non ha API diretta per aggiornare priorità
      // Usiamo query SQL diretta
      await this.pgBoss.db.executeSql(`
        UPDATE pgboss.job
        SET priority = $1
        WHERE id = $2 AND state IN ('created', 'retry')
      `, [PRIORITY_LEVELS[newPriority].value, jobId]);

      this.logger.info(`[PRIORITY_QUEUE] Job promoted`, {
        jobId,
        newPriority,
        newPriorityValue: PRIORITY_LEVELS[newPriority].value,
      });

    } catch (error) {
      this.logger.error(`[PRIORITY_QUEUE] Failed to promote job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Starvation Prevention Monitor
   * Rileva job a bassa priorità rimasti in coda troppo a lungo
   * e li promuove automaticamente
   */
  async checkStarvation() {
    if (!this.config.enableStarvationPrevention) return;

    try {
      // Query job in attesa da oltre threshold
      const staleJobs = await this.pgBoss.db.executeSql(`
        SELECT 
          id,
          name,
          data,
          priority,
          createdon,
          EXTRACT(EPOCH FROM (NOW() - createdon)) * 1000 as wait_time_ms
        FROM pgboss.job
        WHERE state IN ('created', 'retry')
          AND priority < $1  -- Solo job con priorità < NORMAL
          AND createdon < NOW() - INTERVAL '1 hour'
        ORDER BY createdon ASC
        LIMIT 100
      `, [PRIORITY_LEVELS.NORMAL.value]);

      let promoted = 0;

      for (const job of staleJobs.rows) {
        const waitTimeMs = parseFloat(job.wait_time_ms);

        // Determina nuova priorità basata su tempo attesa
        let newPriority;
        if (waitTimeMs > 4 * 60 * 60 * 1000) { // > 4 ore
          newPriority = 'HIGH';
        } else if (waitTimeMs > 2 * 60 * 60 * 1000) { // > 2 ore
          newPriority = 'NORMAL';
        } else {
          continue; // Non promuovere ancora
        }

        await this.promoteJob(job.id, newPriority);
        promoted++;

        this.logger.info(`[PRIORITY_QUEUE] Promoted starving job`, {
          jobId: job.id,
          jobType: job.name,
          oldPriority: job.priority,
          newPriority,
          waitTimeHours: (waitTimeMs / (60 * 60 * 1000)).toFixed(1),
        });
      }

      if (promoted > 0) {
        this.logger.info(`[PRIORITY_QUEUE] Starvation check completed: ${promoted} jobs promoted`);
      }

    } catch (error) {
      this.logger.error('[PRIORITY_QUEUE] Starvation check failed:', error);
    }
  }

  /**
   * Ottieni statistiche coda
   * 
   * @param {string} jobType - Tipo job (opzionale)
   * @returns {Promise<Object>}
   */
  async getQueueStats(jobType = null) {
    try {
      let query = `
        SELECT 
          name as job_type,
          state,
          priority,
          COUNT(*) as count,
          AVG(EXTRACT(EPOCH FROM (NOW() - createdon))) as avg_wait_seconds,
          MAX(EXTRACT(EPOCH FROM (NOW() - createdon))) as max_wait_seconds
        FROM pgboss.job
        WHERE state IN ('created', 'retry', 'active')
      `;

      const params = [];

      if (jobType) {
        query += ` AND name = $1`;
        params.push(jobType);
      }

      query += `
        GROUP BY name, state, priority
        ORDER BY priority DESC, name, state
      `;

      const result = await this.pgBoss.db.executeSql(query, params);

      // Mappa priority value → label
      const stats = result.rows.map(row => {
        const priorityEntry = Object.entries(PRIORITY_LEVELS).find(
          ([_, config]) => config.value === row.priority
        );

        return {
          job_type: row.job_type,
          state: row.state,
          priority: priorityEntry ? priorityEntry[0] : 'UNKNOWN',
          priority_value: row.priority,
          count: parseInt(row.count),
          avg_wait_seconds: parseFloat(row.avg_wait_seconds || 0),
          max_wait_seconds: parseFloat(row.max_wait_seconds || 0),
        };
      });

      return {
        timestamp: new Date().toISOString(),
        stats,
        total_pending: stats
          .filter(s => ['created', 'retry'].includes(s.state))
          .reduce((sum, s) => sum + s.count, 0),
        total_active: stats
          .filter(s => s.state === 'active')
          .reduce((sum, s) => sum + s.count, 0),
      };

    } catch (error) {
      this.logger.error('[PRIORITY_QUEUE] Failed to get stats:', error);
      throw error;
    }
  }

  /**
   * Ottieni job specifico documento
   * Utile per UI status tracking
   * 
   * @param {string} documentId
   * @returns {Promise<Array>}
   */
  async getDocumentJobs(documentId) {
    try {
      const result = await this.pgBoss.db.executeSql(`
        SELECT 
          id,
          name as job_type,
          state,
          priority,
          data,
          createdon,
          startedon,
          completedon,
          output,
          EXTRACT(EPOCH FROM (COALESCE(completedon, NOW()) - createdon)) as duration_seconds
        FROM pgboss.job
        WHERE (data->>'documentId')::text = $1
        ORDER BY createdon DESC
      `, [documentId]);

      return result.rows.map(row => ({
        id: row.id,
        job_type: row.job_type,
        state: row.state,
        priority: row.priority,
        created_at: row.createdon,
        started_at: row.startedon,
        completed_at: row.completedon,
        duration_seconds: parseFloat(row.duration_seconds || 0),
        output: row.output,
      }));

    } catch (error) {
      this.logger.error(`[PRIORITY_QUEUE] Failed to get jobs for document ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Cancella job in attesa
   * 
   * @param {string} jobId
   */
  async cancelJob(jobId) {
    try {
      await this.pgBoss.cancel(jobId);
      this.logger.info(`[PRIORITY_QUEUE] Job cancelled: ${jobId}`);
    } catch (error) {
      this.logger.error(`[PRIORITY_QUEUE] Failed to cancel job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Cancella tutti i job di un documento
   * Utile quando si cancella il documento
   * 
   * @param {string} documentId
   */
  async cancelDocumentJobs(documentId) {
    try {
      const jobs = await this.getDocumentJobs(documentId);
      const pendingJobs = jobs.filter(j => ['created', 'retry'].includes(j.state));

      for (const job of pendingJobs) {
        await this.cancelJob(job.id);
      }

      this.logger.info(`[PRIORITY_QUEUE] Cancelled ${pendingJobs.length} jobs for document ${documentId}`);

    } catch (error) {
      this.logger.error(`[PRIORITY_QUEUE] Failed to cancel jobs for document ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Avvia monitoring periodico (starvation prevention)
   * Da chiamare all'avvio applicazione
   */
  startMonitoring() {
    if (!this.config.enableStarvationPrevention) {
      this.logger.info('[PRIORITY_QUEUE] Starvation prevention disabled');
      return;
    }

    this.monitoringInterval = setInterval(async () => {
      await this.checkStarvation();
    }, this.config.monitoringInterval);

    this.logger.info(`[PRIORITY_QUEUE] Monitoring started (interval: ${this.config.monitoringInterval / 1000}s)`);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.logger.info('[PRIORITY_QUEUE] Monitoring stopped');
    }
  }
}

export default PriorityQueueService;
