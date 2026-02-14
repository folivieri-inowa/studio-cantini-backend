/**
 * Worker OCR - Estrae testo da documenti
 * Processa documenti dalla priority queue e estrae testo tramite Ollama LLaVA
 */

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
import * as Minio from 'minio';
import { DocumentRepository } from '../repositories/document.repository.js';
import { JobRepository } from '../repositories/job.repository.js';
import { PriorityQueueService } from '../services/priority-queue.service.js';

const { Pool } = pg;

// Configurazione
const WORKER_ID = `ocr-worker-${process.pid}`;
const POLL_INTERVAL = 5000; // 5 secondi
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'llava:latest';

// Inizializza connessioni
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const queueService = new PriorityQueueService(process.env.POSTGRES_URL);

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio.studiocantini.wavetech.it',
  port: parseInt(process.env.MINIO_PORT) || 443,
  useSSL: process.env.MINIO_USE_SSL !== 'false',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioAdmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'Inowa2024',
});

/**
 * Estrae testo da immagine/PDF usando Ollama LLaVA
 */
async function extractTextWithVision(imageBuffer, mimeType) {
  try {
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
  } catch (error) {
    console.error('Errore estrazione testo con vision model:', error);
    throw error;
  }
}

/**
 * Processa un singolo job OCR
 */
async function processOCRJob(job) {
  const client = await pool.connect();
  const documentRepo = new DocumentRepository(client);
  const jobRepo = new JobRepository(client);

  try {
    console.log(`📄 [${WORKER_ID}] Processando job OCR: ${job.id} per documento ${job.documentId}`);

    // Marca job come running
    await jobRepo.markAsRunning(job.id, WORKER_ID);

    // Recupera documento
    const document = await documentRepo.findById(job.documentId);
    if (!document) {
      throw new Error(`Documento ${job.documentId} non trovato`);
    }

    // Aggiorna stato documento
    await documentRepo.updateProcessingStatus(document.id, 'ocr_in_progress');

    // Download file da MinIO
    console.log(`📥 Downloading file da MinIO: ${document.storage_path}`);
    const stream = await minioClient.getObject(document.storage_bucket, document.storage_path);
    
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    // Estrai testo
    console.log(`🔍 Estraendo testo con ${VISION_MODEL}...`);
    const extractedText = await extractTextWithVision(fileBuffer, document.mime_type);

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('Nessun testo estratto dal documento');
    }

    console.log(`✅ Estratto testo: ${extractedText.length} caratteri`);

    // Salva testo estratto
    await documentRepo.updateExtractedText(document.id, extractedText);

    // Aggiorna stato documento
    await documentRepo.updateProcessingStatus(document.id, 'ocr_completed');

    // Marca job come completato
    await jobRepo.markAsCompleted(job.id, {
      extractedLength: extractedText.length,
      model: VISION_MODEL,
    });

    // Accoda job di cleaning
    await queueService.enqueueJob('cleaning', document.id, {
      priority: document.priority,
    });

    console.log(`✅ [${WORKER_ID}] Job OCR completato: ${job.id}`);
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
        `OCR failed: ${error.message}`
      );
    }

    // Retry se possibile
    if (job.retry_count < job.max_retries) {
      console.log(`🔄 Riprova ${job.retry_count + 1}/${job.max_retries} per job ${job.id}`);
      await documentRepo.incrementRetryCount(job.documentId);
      await queueService.enqueueJob('ocr', job.documentId, {
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
  console.log(`🚀 [${WORKER_ID}] OCR Worker avviato`);
  console.log(`📡 Ollama URL: ${OLLAMA_URL}`);
  console.log(`🤖 Vision Model: ${VISION_MODEL}`);

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

  // Inizializza priority queue
  await queueService.initialize();
  console.log('✅ Priority queue inizializzata');

  // Poll per nuovi job
  while (true) {
    try {
      // Ottieni prossimo job OCR dalla coda
      const jobs = await queueService.getNextJobs('ocr', 1);

      if (jobs.length > 0) {
        await processOCRJob(jobs[0]);
      } else {
        // Nessun job, attendi
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
