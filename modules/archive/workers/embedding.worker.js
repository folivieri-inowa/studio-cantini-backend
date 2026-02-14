/**
 * Worker Embedding - Crea chunks semantici e embedding vettoriali
 * Utilizza semantic chunking e Ollama per generare embedding
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { DocumentRepository } from '../repositories/document.repository.js';
import { ChunkRepository } from '../repositories/chunk.repository.js';
import { JobRepository } from '../repositories/job.repository.js';
import { PriorityQueueService } from '../services/priority-queue.service.js';
import { SemanticChunkingService } from '../services/semantic-chunking.service.js';

const { Pool } = pg;

// Configurazione
const WORKER_ID = `embedding-worker-${process.pid}`;
const POLL_INTERVAL = 5000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'archive_documents';

// Inizializza connessioni
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const queueService = new PriorityQueueService(process.env.POSTGRES_URL);
const qdrantClient = new QdrantClient({ url: QDRANT_URL });

/**
 * Genera embedding con Ollama
 */
async function generateEmbedding(text) {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.embedding;
  } catch (error) {
    console.error('Errore generazione embedding:', error);
    throw error;
  }
}

/**
 * Assicura che la collection Qdrant esista
 */
async function ensureQdrantCollection() {
  try {
    const collections = await qdrantClient.getCollections();
    const exists = collections.collections.some((c) => c.name === QDRANT_COLLECTION);

    if (!exists) {
      console.log(`📦 Creazione collection Qdrant: ${QDRANT_COLLECTION}`);
      await qdrantClient.createCollection(QDRANT_COLLECTION, {
        vectors: {
          size: 768, // nomic-embed-text dimension
          distance: 'Cosine',
        },
        optimizers_config: {
          default_segment_number: 2,
        },
        replication_factor: 1,
      });
      console.log(`✅ Collection ${QDRANT_COLLECTION} creata`);
    }
  } catch (error) {
    console.error('Errore creazione collection Qdrant:', error);
    throw error;
  }
}

/**
 * Processa un singolo job embedding
 */
async function processEmbeddingJob(job) {
  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);
  const chunkRepo = new ChunkRepository(client);
  const jobRepo = new JobRepository(client);

  try {
    console.log(`🧬 [${WORKER_ID}] Processando job embedding: ${job.id} per documento ${job.documentId}`);

    // Marca job come running
    await jobRepo.markAsRunning(job.id, WORKER_ID);

    // Recupera documento
    const document = await documentRepo.findById(job.documentId);
    if (!document) {
      throw new Error(`Documento ${job.documentId} non trovato`);
    }

    if (!document.extracted_text) {
      throw new Error('Nessun testo estratto per embedding');
    }

    // Aggiorna stato documento
    await documentRepo.updateProcessingStatus(document.id, 'embedding_in_progress');

    // 1. Chunking semantico
    console.log(`✂️ Chunking semantico del testo (${document.extracted_text.length} chars)...`);
    const chunkingService = new SemanticChunkingService();
    const semanticChunks = chunkingService.chunkDocument(
      document.extracted_text,
      document.document_type
    );

    console.log(`✅ Creati ${semanticChunks.length} chunks semantici`);

    // 2. Genera embedding per ogni chunk
    const chunksWithEmbeddings = [];
    
    for (let i = 0; i < semanticChunks.length; i++) {
      const chunk = semanticChunks[i];
      console.log(`🧬 Generando embedding per chunk ${i + 1}/${semanticChunks.length}...`);
      
      const embedding = await generateEmbedding(chunk.text);
      
      chunksWithEmbeddings.push({
        ...chunk,
        embedding,
        documentId: document.id,
        chunkOrder: i,
      });
    }

    // 3. Salva chunks su PostgreSQL
    console.log(`💾 Salvando ${chunksWithEmbeddings.length} chunks su PostgreSQL...`);
    
    const savedChunks = await chunkRepo.createBatch(
      chunksWithEmbeddings.map((c) => ({
        documentId: c.documentId,
        chunkText: c.text,
        chunkOrder: c.chunkOrder,
        chunkType: c.type,
        charStart: c.start,
        charEnd: c.end,
        qdrantCollection: QDRANT_COLLECTION,
        embeddingModel: EMBEDDING_MODEL,
        embeddingDimensions: 768,
        chunkMetadata: c.metadata,
      }))
    );

    console.log(`✅ Salvati ${savedChunks.length} chunks su PostgreSQL`);

    // 4. Upload embedding su Qdrant
    console.log(`☁️ Caricamento ${savedChunks.length} embedding su Qdrant...`);
    
    const qdrantPoints = savedChunks.map((chunk, index) => ({
      id: chunk.id, // Usa UUID del chunk come ID Qdrant
      vector: chunksWithEmbeddings[index].embedding,
      payload: {
        document_id: document.id,
        chunk_order: chunk.chunk_order,
        chunk_type: chunk.chunk_type,
        chunk_text: chunk.chunk_text.substring(0, 500), // Preview
        document_type: document.document_type,
        document_filename: document.original_filename,
        document_date: document.document_date,
        db: document.db,
      },
    }));

    await qdrantClient.upsert(QDRANT_COLLECTION, {
      wait: true,
      points: qdrantPoints,
    });

    // 5. Marca chunks come sincronizzati
    await chunkRepo.markBatchAsSynced(savedChunks.map((c) => c.id));

    console.log(`✅ Caricati ${qdrantPoints.length} punti su Qdrant`);

    // 6. Aggiorna stato documento
    await documentRepo.updateProcessingStatus(document.id, 'completed');

    // Marca job come completato
    await jobRepo.markAsCompleted(job.id, {
      chunksCreated: savedChunks.length,
      embeddingModel: EMBEDDING_MODEL,
      qdrantCollection: QDRANT_COLLECTION,
    });

    console.log(`✅ [${WORKER_ID}] Job embedding completato: ${job.id}`);
    console.log(`📊 Documento ${document.id} processamento completato!`);
  } catch (error) {
    console.error(`❌ [${WORKER_ID}] Errore processando job ${job.id}:`, error);

    // Marca job come failed
    await jobRepo.markAsFailed(job.id, error.message, error.stack);

    // Aggiorna stato documento
    const document = await documentRepo.findById(job.documentId);
    if (document) {
      await documentRepo.updateProcessingStatus(
        document.id,
        'failed',
        `Embedding failed: ${error.message}`
      );
    }

    // Retry se possibile
    if (job.retry_count < job.max_retries) {
      console.log(`🔄 Riprova ${job.retry_count + 1}/${job.max_retries} per job ${job.id}`);
      await documentRepo.incrementRetryCount(job.documentId);
      await queueService.enqueueJob('embedding', job.documentId, {
        priority: document?.priority || 'NORMAL',
      });
    }
  } finally {
    client.release();
  }
}

/**
 * Main worker loop
 */
async function startWorker() {
  console.log(`🚀 [${WORKER_ID}] Embedding Worker avviato`);
  console.log(`📡 Ollama URL: ${OLLAMA_URL}`);
  console.log(`🧬 Embedding Model: ${EMBEDDING_MODEL}`);
  console.log(`☁️ Qdrant URL: ${QDRANT_URL}`);
  console.log(`📦 Qdrant Collection: ${QDRANT_COLLECTION}`);

  // Verifica connessione Ollama
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) {
      throw new Error('Ollama non raggiungibile');
    }
    console.log('✅ Connessione Ollama verificata');
  } catch (error) {
    console.error('❌ Errore connessione Ollama:', error);
    process.exit(1);
  }

  // Assicura collection Qdrant
  try {
    await ensureQdrantCollection();
    console.log('✅ Collection Qdrant pronta');
  } catch (error) {
    console.error('❌ Errore setup Qdrant:', error);
    process.exit(1);
  }

  // Inizializza priority queue
  await queueService.initialize();
  console.log('✅ Priority queue inizializzata');

  // Poll per nuovi job
  while (true) {
    try {
      const jobs = await queueService.getNextJobs('embedding', 1);

      if (jobs.length > 0) {
        await processEmbeddingJob(jobs[0]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }
    } catch (error) {
      console.error(`❌ [${WORKER_ID}] Errore nel worker loop:`, error);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }
}

// Gestione shutdown graceful
process.on('SIGTERM', async () => {
  console.log(`🛑 [${WORKER_ID}] Ricevuto SIGTERM, shutdown graceful...`);
  await pool.end();
  await queueService.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log(`🛑 [${WORKER_ID}] Ricevuto SIGINT, shutdown graceful...`);
  await pool.end();
  await queueService.close();
  process.exit(0);
});

// Avvia worker
startWorker().catch((error) => {
  console.error('❌ Errore fatale nel worker:', error);
  process.exit(1);
});
