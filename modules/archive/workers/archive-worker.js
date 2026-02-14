/**
 * Archive Worker - Sistema di workers basato su pg-boss
 *
 * Questo worker usa pg-boss per job queue robusta con:
 * - Retry automatico con exponential backoff
 * - Dead letter queue per job falliti
 * - Graceful shutdown
 * - Health check
 */

import dotenv from 'dotenv';
dotenv.config();

import PgBoss from 'pg-boss';
import pg from 'pg';
import * as Minio from 'minio';
import { DocumentRepository } from '../repositories/document.repository.js';
import { ChunkRepository } from '../repositories/chunk.repository.js';

const { Pool } = pg;

// Configurazione
const WORKER_ID = process.env.WORKER_ID || `archive-worker-${process.pid}`;
const WORKER_TYPE = process.env.WORKER_TYPE || 'all'; // 'ocr', 'cleaning', 'embedding', 'all'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'llava:latest';
const CLEANING_MODEL = process.env.OLLAMA_CLEANING_MODEL || 'llama3.1:8b';

// Connessioni
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio.studiocantini.wavetech.it',
  port: parseInt(process.env.MINIO_PORT) || 443,
  useSSL: process.env.MINIO_USE_SSL !== 'false',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioAdmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'Inowa2024',
});

// Inizializza pg-boss
const boss = new PgBoss({
  connectionString: process.env.POSTGRES_URL,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInMinutes: 60,  // Max 1 ora per job
  retentionDays: 1,      // Minimo per pg-boss
  deleteAfterDays: 7,    // Pulizia dopo 7 giorni
  archiveFailedAfterDays: 1,
});

// Health check state
let health = {
  status: 'starting',
  lastActivity: Date.now(),
  jobsProcessed: 0,
  jobsFailed: 0,
  errors: [],
};

/**
 * Estrae testo da immagine/PDF usando Ollama LLaVA
 */
async function extractTextWithVision(imageBuffer) {
  const base64Image = imageBuffer.toString('base64');

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      prompt: 'Estrai tutto il testo da questa immagine. Preserva la struttura, le tabelle e la formattazione. Restituisci solo il testo estratto senza commenti.',
      images: [base64Image],
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.response;
}

/**
 * Genera embeddings usando Ollama
 */
async function generateEmbedding(text) {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.embedding;
}

/**
 * Pulisce il testo usando LLM
 */
async function cleanTextWithLLM(text) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLEANING_MODEL,
      prompt: `Pulisci e formatta il seguente testo estratto da un documento. Correggi errori OCR, migliora la formattazione, preserva struttura e tabelle. Restituisci SOLO il testo pulito:\n\n${text.substring(0, 4000)}`,
      stream: false,
      options: {
        temperature: 0.1,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama cleaning error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.response;
}

/**
 * Divide il testo in chunks semanticamente coerenti
 */
function chunkText(text, maxChunkSize = 800, overlap = 100) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  let currentChunk = '';
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      // Overlap: inizia con l'ultima parte del chunk precedente
      currentChunk = currentChunk.slice(-overlap) + sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Download file da MinIO
 */
async function downloadFromMinIO(bucket, objectPath) {
  const stream = await minioClient.getObject(bucket, objectPath);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Handler job OCR
 */
async function handleOCRJob(job) {
  console.log(`📄 [${WORKER_ID}] OCR Job: ${job.id}, Document: ${job.data.documentId}`);

  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);

  try {
    const { documentId, db } = job.data;

    // Recupera documento
    const document = await documentRepo.findById(documentId);
    if (!document) {
      throw new Error(`Documento ${documentId} non trovato`);
    }

    // Aggiorna stato
    await documentRepo.updateProcessingStatus(document.id, 'ocr_in_progress');

    // Download file
    console.log(`📥 Downloading: ${document.storage_path}`);
    const fileBuffer = await downloadFromMinIO(document.storage_bucket, document.storage_path);

    // Estrai testo
    console.log(`🔍 OCR con ${VISION_MODEL}...`);
    const extractedText = await extractTextWithVision(fileBuffer);

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('Nessun testo estratto');
    }

    console.log(`✅ Estratti ${extractedText.length} caratteri`);

    // Salva testo
    await documentRepo.updateExtractedText(document.id, extractedText);
    await documentRepo.updateProcessingStatus(document.id, 'ocr_completed');

    // Accoda job cleaning
    await boss.send('archive-cleaning', { documentId, db }, {
      priority: job.data._priority === 'URGENT' ? 100 : 50,
    });

    health.jobsProcessed++;
    console.log(`✅ OCR completato: ${job.id}`);

  } catch (error) {
    health.jobsFailed++;
    health.errors.push({ time: new Date(), error: error.message, job: job.id });
    console.error(`❌ OCR Error: ${error.message}`);
    throw error; // Rilancia per retry pg-boss
  } finally {
    client.release();
  }
}

/**
 * Handler job Cleaning
 */
async function handleCleaningJob(job) {
  console.log(`🧹 [${WORKER_ID}] Cleaning Job: ${job.id}, Document: ${job.data.documentId}`);

  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);

  try {
    const { documentId, db } = job.data;

    const document = await documentRepo.findById(documentId);
    if (!document || !document.extracted_text) {
      throw new Error('Documento o testo estratto non trovato');
    }

    await documentRepo.updateProcessingStatus(document.id, 'cleaning_in_progress');

    // Pulisci testo
    console.log(`🧹 Cleaning testo...`);
    const cleanedText = await cleanTextWithLLM(document.extracted_text);

    await documentRepo.updateCleanedText(document.id, cleanedText);
    await documentRepo.updateProcessingStatus(document.id, 'cleaning_completed');

    // Accoda job embedding
    await boss.send('archive-embedding', { documentId, db }, {
      priority: job.data._priority === 'URGENT' ? 100 : 50,
    });

    health.jobsProcessed++;
    console.log(`✅ Cleaning completato: ${job.id}`);

  } catch (error) {
    health.jobsFailed++;
    health.errors.push({ time: new Date(), error: error.message, job: job.id });
    console.error(`❌ Cleaning Error: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Handler job Embedding
 */
async function handleEmbeddingJob(job) {
  console.log(`🔢 [${WORKER_ID}] Embedding Job: ${job.id}, Document: ${job.data.documentId}`);

  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);
  const chunkRepo = new ChunkRepository(client);

  try {
    const { documentId, db } = job.data;

    const document = await documentRepo.findById(documentId);
    if (!document || !document.cleaned_text) {
      throw new Error('Documento o testo pulito non trovato');
    }

    await documentRepo.updateProcessingStatus(document.id, 'embedding_in_progress');

    // Chunking
    console.log(`✂️  Chunking...`);
    const chunks = chunkText(document.cleaned_text);
    console.log(`📊 Creati ${chunks.length} chunks`);

    // Genera embeddings e salva
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      console.log(`🔢 Embedding chunk ${i + 1}/${chunks.length}...`);

      const embedding = await generateEmbedding(chunkText);

      await chunkRepo.createChunk({
        document_id: documentId,
        db,
        chunk_index: i,
        chunk_text: chunkText,
        embedding,
        page_start: 1, // TODO: estrai da OCR
        page_end: 1,
      });
    }

    await documentRepo.updateProcessingStatus(document.id, 'completed');

    health.jobsProcessed++;
    console.log(`✅ Embedding completato: ${job.id}`);

  } catch (error) {
    health.jobsFailed++;
    health.errors.push({ time: new Date(), error: error.message, job: job.id });
    console.error(`❌ Embedding Error: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Health check endpoint
 */
async function healthCheck() {
  const now = Date.now();
  const inactiveTime = now - health.lastActivity;

  // Considera unhealthy se inattivo per più di 5 minuti
  if (inactiveTime > 5 * 60 * 1000 && health.status === 'running') {
    health.status = 'stalled';
  }

  return {
    workerId: WORKER_ID,
    workerType: WORKER_TYPE,
    status: health.status,
    uptime: process.uptime(),
    jobsProcessed: health.jobsProcessed,
    jobsFailed: health.jobsFailed,
    lastActivity: new Date(health.lastActivity).toISOString(),
    inactiveSeconds: Math.floor(inactiveTime / 1000),
    memory: process.memoryUsage(),
    recentErrors: health.errors.slice(-5),
  };
}

/**
 * Avvia il worker
 */
async function startWorker() {
  console.log(`🚀 [${WORKER_ID}] Avvio Archive Worker (type: ${WORKER_TYPE})`);

  // Verifica connessione Ollama
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) throw new Error('Ollama non raggiungibile');
    console.log('✅ Connessione Ollama verificata');
  } catch (error) {
    console.error('❌ Ollama non raggiungibile:', error.message);
    process.exit(1);
  }

  // Avvia pg-boss
  await boss.start();
  console.log('✅ pg-boss connesso');

  // Registra handlers in base al tipo di worker
  const workerTypes = WORKER_TYPE === 'all' ? ['ocr', 'cleaning', 'embedding'] : [WORKER_TYPE];

  if (workerTypes.includes('ocr')) {
    await boss.work('archive-ocr', { batchSize: 1, pollingInterval: 2000 }, async (jobs) => {
      health.lastActivity = Date.now();
      for (const job of jobs) {
        await handleOCRJob(job);
      }
    });
    console.log('✅ Handler OCR registrato');
  }

  if (workerTypes.includes('cleaning')) {
    await boss.work('archive-cleaning', { batchSize: 1, pollingInterval: 2000 }, async (jobs) => {
      health.lastActivity = Date.now();
      for (const job of jobs) {
        await handleCleaningJob(job);
      }
    });
    console.log('✅ Handler Cleaning registrato');
  }

  if (workerTypes.includes('embedding')) {
    await boss.work('archive-embedding', { batchSize: 1, pollingInterval: 2000 }, async (jobs) => {
      health.lastActivity = Date.now();
      for (const job of jobs) {
        await handleEmbeddingJob(job);
      }
    });
    console.log('✅ Handler Embedding registrato');
  }

  health.status = 'running';
  console.log(`✅ [${WORKER_ID}] Worker attivo e in ascolto`);

  // Health check periodico
  setInterval(async () => {
    const status = await healthCheck();
    console.log(`💚 Health Check: ${status.status}, Jobs: ${status.jobsProcessed}/${status.jobsFailed}`);
  }, 60000);
}

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  console.log(`\n🛑 [${WORKER_ID}] Ricevuto ${signal}, shutdown graceful...`);
  health.status = 'stopping';

  // Stop pg-boss (aspetta che i job in corso finiscano)
  await boss.stop({ graceful: true, timeout: 30000 });
  console.log('✅ pg-boss fermato');

  // Chiudi pool PostgreSQL
  await pool.end();
  console.log('✅ Pool PostgreSQL chiuso');

  console.log(`👋 [${WORKER_ID}] Arrivederci`);
  process.exit(0);
}

// Gestione segnali
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Gestione errori non catturati
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  health.errors.push({ time: new Date(), error: error.message });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  health.errors.push({ time: new Date(), error: String(reason) });
});

// Avvia
startWorker().catch((error) => {
  console.error('❌ Errore fatale:', error);
  process.exit(1);
});
