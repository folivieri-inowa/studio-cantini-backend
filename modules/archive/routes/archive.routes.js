/**
 * Routes per il modulo Archivio Digitale Intelligente
 * Gestisce upload, ricerca, e gestione documenti
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DocumentRepository } from '../repositories/document.repository.js';
import { ChunkRepository } from '../repositories/chunk.repository.js';
import { JobRepository } from '../repositories/job.repository.js';
import ChatRepository from '../repositories/chat.repository.js';
import { DeduplicationService } from '../services/deduplication.service.js';
import { PriorityQueueService } from '../services/priority-queue.service.js';
import { HybridSearchService } from '../services/hybrid-search.service.js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { sanitizeFileName } from '../../../lib/utils.js';
import { createMinioClient, getMinioBaseUrl } from '../../../lib/minio-config.js';
import { getBoss } from '../workers/boss.singleton.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const archiveRoutes = async (fastify) => {
  // Configurazione storage locale (fallback se MinIO non è disponibile)
  const USE_LOCAL_STORAGE = process.env.USE_LOCAL_STORAGE === 'true'; // Default: usa MinIO se configurato
  const LOCAL_STORAGE_PATH = path.join(__dirname, '../../../storage/archive');

  // Debug: log delle variabili d'ambiente MinIO
  console.log('[MINIO CONFIG] Env vars:', {
    MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
    MINIO_PORT: process.env.MINIO_PORT,
    MINIO_USE_SSL: process.env.MINIO_USE_SSL,
    MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY ? '***' : undefined,
    MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY ? '***' : undefined,
    USE_LOCAL_STORAGE: process.env.USE_LOCAL_STORAGE,
  });

  // Inizializza MinIO client usando la configurazione centralizzata
  let minioClient = null;
  if (!USE_LOCAL_STORAGE) {
    try {
      minioClient = createMinioClient();
      console.log('[MINIO CONFIG] Client inizializzato con configurazione centralizzata');
    } catch (err) {
      console.error('[MINIO CONFIG] Errore inizializzazione client:', err.message);
    }
  }

  const bucketName = process.env.MINIO_ARCHIVE_BUCKET || 'archive';

  let bucketReady = false;
  let bucketInitPromise = null;
  
  // Assicura che la directory locale esista
  if (USE_LOCAL_STORAGE) {
    try {
      await fs.mkdir(LOCAL_STORAGE_PATH, { recursive: true });
      console.log(`📁 Storage locale archivio: ${LOCAL_STORAGE_PATH}`);
    } catch (err) {
      console.error('❌ Errore creazione directory storage:', err);
    }
  }

  const withTimeout = (promise, timeoutMs, message) =>
    Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);

  const ensureArchiveBucketReady = async () => {
    if (bucketReady) return true;

    if (!bucketInitPromise) {
      bucketInitPromise = (async () => {
        const minioBaseUrl = getMinioBaseUrl();
        console.log(`[MINIO] Verifica connessione a ${minioBaseUrl}`);
        console.log(`[MINIO] Bucket target: ${bucketName}`);

        let bucketExists = false;
        try {
          console.log('[MINIO] Chiamata bucketExists...');
          bucketExists = await withTimeout(
            minioClient.bucketExists(bucketName),
            10000,
            `Timeout verifica bucket MinIO: ${bucketName}`
          );
          console.log(`[MINIO] bucketExists risultato: ${bucketExists}`);
        } catch (err) {
          console.error('[MINIO] ERRORE bucketExists:', err.message || 'Nessun messaggio');
          console.error('[MINIO] Errore completo:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
          console.error('[MINIO] Stack:', err.stack);
          throw err;
        }

        if (!bucketExists) {
          console.log(`[MINIO] Bucket ${bucketName} non esiste, creazione...`);
          try {
            await withTimeout(
              minioClient.makeBucket(bucketName, 'us-east-1'),
              10000,
              `Timeout creazione bucket MinIO: ${bucketName}`
            );
            console.log(`[MINIO] Bucket ${bucketName} creato con successo`);
          } catch (err) {
            console.error('[MINIO] ERRORE creazione bucket:', err.message);
            throw err;
          }
        } else {
          console.log(`[MINIO] Bucket ${bucketName} già esistente`);
        }

        bucketReady = true;
      })().catch((error) => {
        console.error('[MINIO] ERRORE inizializzazione:', error.message);
        bucketInitPromise = null;
        throw error;
      });
    }

    try {
      await bucketInitPromise;
      return true;
    } catch (error) {
      fastify.log.warn(`Archive storage non disponibile: ${error.message}`);
      return false;
    }
  };

  /**
   * POST /archive/upload
   * Upload di un nuovo documento nell'archivio
   */
  fastify.post('/upload', async (request, reply) => {
    let boss = null;
    try {
      // Collect all parts first - IMPORTANT: we must consume the file stream
      // during iteration or it will block the multipart parser
      const parts = request.parts();

      let fileBuffer = null;
      let fileInfo = null;
      const fields = {};

      // Iterate through all parts - MUST consume file stream immediately
      for await (const part of parts) {
        if (part.type === 'file') {
          // CRITICAL: Must consume file stream immediately during iteration
          const chunks = [];
          try {
            for await (const chunk of part.file) {
              chunks.push(chunk);
            }
            fileBuffer = Buffer.concat(chunks);
            fileInfo = {
              filename: part.filename,
              mimetype: part.mimetype,
            };
          } catch (fileErr) {
            console.error('[UPLOAD] ERRORE lettura file:', fileErr);
            throw new Error(`Errore lettura file: ${fileErr.message}`);
          }
        } else {
          // This is a form field
          fields[part.fieldname] = part.value;
        }
      }

      if (!fileBuffer || !fileInfo) {
        return reply.code(400).send({ error: 'Nessun file fornito' });
      }

      const { filename, mimetype } = fileInfo;
      const { db, documentType, documentSubtype, title, description, documentDate, fiscalYear, priority, folderPath, folderPathArray, parentFolder } = fields;

      // Validazione db
      if (!db) {
        return reply.code(400).send({ error: 'Campo "db" obbligatorio' });
      }

      // Inizializza repositories
      const documentRepo = new DocumentRepository(fastify.pg);
      const jobRepo = new JobRepository(fastify.pg);
      const deduplicationService = new DeduplicationService({
        pgPool: fastify.pg,
        logger: fastify.log || console,
      });

      // Usa il singleton pg-boss (non creare/distruggere ad ogni richiesta)
      boss = await getBoss(process.env.POSTGRES_URL);

      // Calcola hash dal buffer già letto
      const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const fileSize = fileBuffer.length;

      // 1. Controllo deduplicazione esatta
      const existingDoc = await deduplicationService.findExactDuplicate(fileHash, db);
      if (existingDoc) {
        return reply.code(409).send({
          error: 'Documento duplicato',
          message: 'Un documento identico è già presente nell\'archivio',
          existingDocument: {
            id: existingDoc.id,
            filename: existingDoc.original_filename,
            createdAt: existingDoc.created_at,
          },
        });
      }

      // 2. Upload su storage (MinIO o locale)
      const sanitizedFilename = sanitizeFileName(filename);
      const timestamp = Date.now();

      // Estrai informazioni sulla cartella dal folderPath se fornito
      let folderPathValue = folderPath || '';
      let parsedFolderPathArray = [];
      let parsedParentFolder = null;

      if (folderPathValue) {
        // Rimuovi slash iniziali/finali e dividi
        folderPathValue = folderPathValue.replace(/^\/+|\/+$/g, '');
        if (folderPathValue) {
          parsedFolderPathArray = folderPathValue.split('/');
          parsedParentFolder = parsedFolderPathArray[parsedFolderPathArray.length - 1];
        }
      }

      // Se il frontend invia già folderPathArray come stringa JSON, parsalo
      if (folderPathArray && typeof folderPathArray === 'string') {
        try {
          parsedFolderPathArray = JSON.parse(folderPathArray);
        } catch (e) {
          // Se non è JSON, usa il valore derivato da folderPath
        }
      }

      // Se il frontend invia parentFolder, usalo
      if (parentFolder) {
        parsedParentFolder = parentFolder;
      }

      // Costruisci il percorso includendo la cartella
      const folderSegment = folderPathValue ? `${folderPathValue}/` : '';
      const objectName = `${db}/${folderSegment}${timestamp}_${sanitizedFilename}`;
      
      let storagePath;
      let fileUrl;
      
      if (USE_LOCAL_STORAGE) {
        // Salva su filesystem locale
        const fullPath = path.join(LOCAL_STORAGE_PATH, objectName);
        const dirPath = path.dirname(fullPath);
        
        // Crea directory se non esiste
        await fs.mkdir(dirPath, { recursive: true });
        
        // Scrivi il file
        await fs.writeFile(fullPath, fileBuffer);
        
        storagePath = objectName;
        fileUrl = `/api/archive/files/${objectName}`; // URL relativo per accesso via API
        
        console.log(`✅ File salvato localmente: ${fullPath}`);
      } else {
        // Upload su MinIO
        const storageReady = await ensureArchiveBucketReady();
        if (!storageReady) {
          return reply.code(503).send({
            error: 'Storage archivio non disponibile',
            message: 'MinIO non raggiungibile. Riprova più tardi.',
          });
        }

        await minioClient.putObject(bucketName, objectName, fileBuffer, {
          'Content-Type': mimetype,
        });

        storagePath = objectName;
        fileUrl = `${getMinioBaseUrl()}/${bucketName}/${objectName}`;
        
        console.log(`✅ File caricato su MinIO: ${fileUrl}`);
      }

      // 3. Crea record documento nel database
      let document;
      try {
        document = await documentRepo.create({
          db,
          originalFilename: filename,
          fileSize,
          mimeType: mimetype,
          fileHash,
          storagePath,
          storageBucket: bucketName,
          folderPath: folderPathValue,
          folderPathArray: parsedFolderPathArray,
          parentFolder: parsedParentFolder,
          documentType: documentType || null,
          documentSubtype: documentSubtype || null,
          title: title || filename, // Usa filename come fallback per title
          description: description || null,
          documentDate: documentDate || null,
          fiscalYear: fiscalYear ? parseInt(fiscalYear) : null,
          priority: priority || 'NORMAL',
          createdBy: request.user?.username, // Assumendo autenticazione JWT
        });
      } catch (dbError) {
        console.error('[UPLOAD] ❌ ERRORE DB:', dbError.message, dbError.code, dbError.constraint);

        // Se c'è un errore di duplicato, cancella il file appena salvato
        if (dbError.code === '23505') {
          try {
            if (USE_LOCAL_STORAGE) {
              const fullPath = path.join(LOCAL_STORAGE_PATH, objectName);
              await fs.unlink(fullPath);
            }
            // Per MinIO non cancelliamo perché non siamo arrivati a quel punto
          } catch (cleanupErr) {
            console.error('[UPLOAD] ⚠️ Errore cancellazione file:', cleanupErr.message);
          }
          if (dbError.constraint === 'archive_documents_file_hash_key') {
            return reply.code(409).send({
              error: 'Documento duplicato',
              message: 'Un documento identico è già presente nell\'archivio (hash duplicato)',
            });
          }
        }
        throw dbError; // Rilancia altri errori
      }

      // 4. Avvia pipeline di processamento tramite pg-boss
      let jobId = null;
      try {
        // Verifica che il queue esista
        await boss.createQueue('archive-ocr');

        jobId = await boss.send('archive-ocr', {
          documentId: document.id,
          db: db,
        }, {
          priority: document.priority === 'URGENT' ? 100 : 50,
          retryLimit: 3,
          retryDelay: 30,
          expireInMinutes: 60,
        });
        console.log(`[UPLOAD] ✅ Job OCR accodato per documento ${document.id}, jobId: ${jobId}`);

        if (!jobId) {
          console.error('[UPLOAD] ⚠️ Job ID è null, possibile problema con pg-boss');
        }

        // Aggiorna stato documento
        await documentRepo.updateProcessingStatus(document.id, jobId ? 'pending' : 'failed');
      } catch (queueError) {
        console.error('[UPLOAD] ❌ Errore accodamento job:', queueError);
        console.error('[UPLOAD] Stack:', queueError.stack);
        // Non bloccare l'upload se l'accodamento fallisce
        try {
          await documentRepo.updateProcessingStatus(document.id, 'failed');
        } catch (e) {
          console.error('[UPLOAD] ❌ Errore aggiornamento stato:', e);
        }
      } finally {
        // Il singleton pg-boss NON va mai fermato nelle routes
      }

      // 5. Controllo deduplicazione fuzzy in background (opzionale - richiede embeddings)
      // TODO: Abilitare quando Qdrant/Ollama saranno configurati
      // deduplicationService.findFuzzyDuplicates(document.id, {
      //   similarityThreshold: 0.85,
      // }).then(async (fuzzyDuplicates) => {
      //   if (fuzzyDuplicates.length > 0) {
      //     console.log(`⚠️ Trovati ${fuzzyDuplicates.length} possibili duplicati fuzzy`);
      //     await documentRepo.markAsDuplicate(document.id, fuzzyDuplicates[0].id);
      //   }
      // }).catch((err) => {
      //   console.error('Errore controllo duplicati fuzzy:', err);
      // });

      return reply.code(201).send({
        success: true,
        message: 'Documento caricato con successo',
        document: {
          id: document.id,
          filename: document.original_filename,
          fileSize: document.file_size,
          mimeType: document.mime_type,
          documentType: document.document_type,
          priority: document.priority,
          status: document.processing_status,
          url: fileUrl,
          createdAt: document.created_at,
        },
      });
    } catch (error) {
      console.error('[UPLOAD] ❌ ERRORE:', error);
      console.error('[UPLOAD] Stack:', error.stack);
      // NOTA: pg-boss è un singleton condiviso, NON va mai fermato nelle routes
      return reply.code(500).send({
        error: 'Errore durante il caricamento del documento',
        message: error.message,
      });
    }
  });

  /**
   * POST /archive/folders
   * Crea una nuova cartella
   */
  fastify.post('/folders', async (request, reply) => {
    try {
      const { db, folderName, parentPath = '' } = request.body;

      if (!db || !folderName) {
        return reply.code(400).send({ error: 'Parametri "db" e "folderName" obbligatori' });
      }

      // Sanitizza il nome cartella
      const sanitizedFolderName = folderName.replace(/[^a-zA-Z0-9-_]/g, '_');
      const fullPath = parentPath ? `${parentPath}/${sanitizedFolderName}` : sanitizedFolderName;

      // Crea la directory fisica
      const dirPath = path.join(LOCAL_STORAGE_PATH, db, fullPath);
      await fs.mkdir(dirPath, { recursive: true });

      console.log(`[FOLDER] ✅ Cartella creata: ${fullPath}`);

      return reply.code(201).send({
        success: true,
        message: 'Cartella creata con successo',
        folder: {
          name: sanitizedFolderName,
          path: fullPath,
          parentPath,
        },
      });
    } catch (error) {
      console.error('[FOLDER] ❌ Errore creazione cartella:', error);
      return reply.code(500).send({
        error: 'Errore durante la creazione della cartella',
        message: error.message,
      });
    }
  });

  /**
   * PUT /archive/folders
   * Rinomina una cartella
   */
  fastify.put('/folders', async (request, reply) => {
    try {
      const { db, oldPath, newName } = request.body;

      if (!db || !oldPath || !newName) {
        return reply.code(400).send({ error: 'Parametri "db", "oldPath" e "newName" obbligatori' });
      }

      // Sanitizza il nuovo nome
      const sanitizedNewName = newName.replace(/[^a-zA-Z0-9-_]/g, '_');

      // Calcola i percorsi
      const parentPath = path.dirname(oldPath);
      const newPath = parentPath === '.' ? sanitizedNewName : `${parentPath}/${sanitizedNewName}`;

      const oldFullPath = path.join(LOCAL_STORAGE_PATH, db, oldPath);
      const newFullPath = path.join(LOCAL_STORAGE_PATH, db, newPath);

      // Rinomina la directory
      await fs.rename(oldFullPath, newFullPath);

      // Aggiorna i documenti nel DB che hanno questo percorso
      const documentRepo = new DocumentRepository(fastify.pg);
      await documentRepo.updateFolderPath(db, oldPath, newPath);

      console.log(`[FOLDER] ✅ Cartella rinominata: ${oldPath} -> ${newPath}`);

      return reply.code(200).send({
        success: true,
        message: 'Cartella rinominata con successo',
        folder: {
          oldPath,
          newPath,
          newName: sanitizedNewName,
        },
      });
    } catch (error) {
      console.error('[FOLDER] ❌ Errore rinomina cartella:', error);
      return reply.code(500).send({
        error: 'Errore durante la rinominazione della cartella',
        message: error.message,
      });
    }
  });

  /**
   * DELETE /archive/folders
   * Elimina una cartella (solo se vuota)
   */
  fastify.delete('/folders', async (request, reply) => {
    try {
      const { db, folderPath } = request.query;

      if (!db || !folderPath) {
        return reply.code(400).send({ error: 'Parametri "db" e "folderPath" obbligatori' });
      }

      const fullPath = path.join(LOCAL_STORAGE_PATH, db, folderPath);

      // Verifica se la cartella esiste
      try {
        await fs.access(fullPath);
      } catch {
        return reply.code(404).send({ error: 'Cartella non trovata' });
      }

      // Verifica se ci sono documenti nel DB in questa cartella
      const documentRepo = new DocumentRepository(fastify.pg);
      const documentsInFolder = await documentRepo.countByFolder(db, folderPath);

      if (documentsInFolder > 0) {
        return reply.code(409).send({
          error: 'Cartella non vuota',
          message: `La cartella contiene ${documentsInFolder} documenti. Sposta o elimina i documenti prima di eliminare la cartella.`,
        });
      }

      // Elimina la cartella
      await fs.rmdir(fullPath);

      console.log(`[FOLDER] ✅ Cartella eliminata: ${folderPath}`);

      return reply.code(200).send({
        success: true,
        message: 'Cartella eliminata con successo',
      });
    } catch (error) {
      console.error('[FOLDER] ❌ Errore eliminazione cartella:', error);
      return reply.code(500).send({
        error: 'Errore durante l\'eliminazione della cartella',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/folders
   * Lista cartelle
   */
  fastify.get('/folders', async (request, reply) => {
    try {
      const { db, parentPath = '' } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const basePath = path.join(LOCAL_STORAGE_PATH, db, parentPath);

      // Leggi le cartelle
      let folders = [];
      try {
        const entries = await fs.readdir(basePath, { withFileTypes: true });
        folders = entries
          .filter(entry => entry.isDirectory())
          .map(entry => ({
            name: entry.name,
            path: parentPath ? `${parentPath}/${entry.name}` : entry.name,
            parentPath,
          }));
      } catch {
        // Se la cartella non esiste, restituisci array vuoto
        folders = [];
      }

      return reply.code(200).send({
        success: true,
        folders,
      });
    } catch (error) {
      console.error('[FOLDER] ❌ Errore lista cartelle:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero delle cartelle',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/documents
   * Lista documenti con filtri
   */
  fastify.get('/documents', async (request, reply) => {
    try {
      const { db, status, priority, documentType, folderPath, limit = 50, offset = 0 } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const documentRepo = new DocumentRepository(fastify.pg);

      const documents = await documentRepo.findByDatabase(db, {
        status,
        priority,
        documentType,
        folderPath,
        limit: parseInt(limit),
        offset: parseInt(offset),
      });

      const total = await documentRepo.countByDatabase(db, {
        status,
        documentType,
        folderPath,
      });

      return reply.send({
        success: true,
        data: documents,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      });
    } catch (error) {
      console.error('Errore recupero documenti:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero dei documenti',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/documents/:id
   * Dettaglio singolo documento
   */
  fastify.get('/documents/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      const documentRepo = new DocumentRepository(fastify.pg);
      const chunkRepo = new ChunkRepository(fastify.pg);
      const jobRepo = new JobRepository(fastify.pg);

      const document = await documentRepo.findById(id);
      if (!document) {
        return reply.code(404).send({ error: 'Documento non trovato' });
      }

      // Recupera chunks e jobs associati
      const chunks = await chunkRepo.findByDocumentId(id);
      const jobs = await jobRepo.findByDocumentId(id);

      return reply.send({
        success: true,
        document: {
          ...document,
          chunksCount: chunks.length,
          chunks: chunks.slice(0, 5), // Solo primi 5 chunks per preview
          jobs: jobs.slice(0, 10), // Ultimi 10 jobs
        },
      });
    } catch (error) {
      console.error('Errore recupero documento:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero del documento',
        message: error.message,
      });
    }
  });

  /**
   * POST /archive/search
   * Ricerca ibrida: full-text (PostgreSQL tsvector) + semantica (Qdrant RRF)
   * Fallback a ricerca keyword-only se Qdrant/Ollama non disponibili.
   */
  fastify.post('/search', async (request, reply) => {
    try {
      const { db, query, filters = {}, limit = 20, offset = 0 } = request.body;

      if (!db || !query) {
        return reply.code(400).send({ error: 'Parametri "db" e "query" obbligatori' });
      }

      try {
        // Ricerca ibrida tramite HybridSearchService
        const hybridSearch = createHybridSearchService();
        const searchResults = await hybridSearch.search({
          db,
          query,
          ...filters,
          limit,
          offset,
        });

        return reply.send({
          success: true,
          query,
          results: (searchResults.results || []).map(r => ({
            document_id: r.document_id || r.id,
            id: r.document_id || r.id,
            original_filename: r.original_filename,
            title: r.title,
            file_size: r.file_size,
            mime_type: r.mime_type,
            processing_status: r.processing_status,
            priority: r.priority,
            created_at: r.created_at,
            folder_path: r.folder_path,
            relevance_score: r.final_score || r.rrfScore || 1.0,
            match_type: r.match_type || 'hybrid',
            highlight: r.chunk_text ? r.chunk_text.substring(0, 500) : (r.extracted_text ? r.extracted_text.substring(0, 500) : null),
          })),
          metrics: {
            total_results: searchResults.total || 0,
            fulltext_count: searchResults.fulltext_count || 0,
            semantic_count: searchResults.semantic_count || 0,
            search_time_ms: searchResults.search_time_ms || 0,
          },
          pagination: { limit, offset },
        });
      } catch (hybridErr) {
        // Fallback a ricerca keyword se Qdrant/Ollama non disponibili
        fastify.log.warn({ err: hybridErr }, '[SEARCH] Fallback a ricerca keyword (hybrid search non disponibile)');

        const searchTerm = `%${query}%`;
        const result = await fastify.pg.query(
          `SELECT id, original_filename, title, file_size, mime_type,
                  processing_status, priority, created_at, folder_path,
                  extracted_text
           FROM archive_documents
           WHERE db = $1
             AND deleted_at IS NULL
             AND (
               original_filename ILIKE $2
               OR COALESCE(title, '') ILIKE $2
               OR COALESCE(extracted_text, '') ILIKE $2
             )
           ORDER BY created_at DESC
           LIMIT $3 OFFSET $4`,
          [db, searchTerm, limit, offset]
        );

        return reply.send({
          success: true,
          query,
          fallback: true,
          results: result.rows.map(doc => ({
            document_id: doc.id,
            id: doc.id,
            original_filename: doc.original_filename,
            title: doc.title,
            file_size: doc.file_size,
            mime_type: doc.mime_type,
            processing_status: doc.processing_status,
            priority: doc.priority,
            created_at: doc.created_at,
            folder_path: doc.folder_path,
            relevance_score: 1.0,
            match_type: 'fulltext',
            highlight: doc.extracted_text ? doc.extracted_text.substring(0, 500) : null,
          })),
          metrics: { total_results: result.rows.length, fulltext_count: result.rows.length, semantic_count: 0 },
          pagination: { limit, offset },
        });
      }
    } catch (error) {
      console.error('Errore ricerca:', error);
      return reply.code(500).send({
        error: 'Errore durante la ricerca',
        message: error.message,
      });
    }
  });

  /**
   * DELETE /archive/documents/:id
   * Soft delete documento + eliminazione file da storage
   */
  fastify.delete('/documents/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      const documentRepo = new DocumentRepository(fastify.pg);
      const document = await documentRepo.findById(id);

      if (!document) {
        return reply.code(404).send({ error: 'Documento non trovato' });
      }

      // Elimina il file fisico dallo storage
      if (!USE_LOCAL_STORAGE && minioClient && document.storage_path) {
        try {
          const storageReady = await ensureArchiveBucketReady();
          if (storageReady) {
            await minioClient.removeObject(bucketName, document.storage_path);
            console.log(`[DELETE] File eliminato da MinIO: ${document.storage_path}`);
          }
        } catch (minioErr) {
          console.error('[DELETE] Errore eliminazione file da MinIO:', minioErr.message);
          // Non blocchiamo l'eliminazione del documento se il file non esiste già
        }
      } else if (USE_LOCAL_STORAGE && document.storage_path) {
        try {
          const fullPath = path.join(LOCAL_STORAGE_PATH, document.storage_path);
          await fs.unlink(fullPath);
          console.log(`[DELETE] File eliminato da local storage: ${fullPath}`);
        } catch (fsErr) {
          console.error('[DELETE] Errore eliminazione file locale:', fsErr.message);
        }
      }

      await documentRepo.softDelete(id, request.user?.username);

      return reply.send({
        success: true,
        message: 'Documento eliminato con successo',
      });
    } catch (error) {
      console.error('Errore eliminazione documento:', error);
      return reply.code(500).send({
        error: 'Errore durante l\'eliminazione del documento',
        message: error.message,
      });
    }
  });

  /**
   * PUT /archive/documents/rename
   * Rinomina un file (solo il nome, non sposta)
   */
  fastify.put('/documents/rename', async (request, reply) => {
    try {
      const { db, documentId, newName } = request.body;

      if (!db || !documentId || !newName) {
        return reply.code(400).send({ error: 'Parametri "db", "documentId" e "newName" obbligatori' });
      }

      const documentRepo = new DocumentRepository(fastify.pg);
      const document = await documentRepo.findById(documentId);

      if (!document || document.db !== db) {
        return reply.code(404).send({ error: 'Documento non trovato' });
      }

      // Aggiorna solo il titolo/original_filename
      await documentRepo.update(documentId, {
        title: newName,
        original_filename: newName,
      });

      console.log(`[FILE] ✅ File rinominato: ${documentId} -> ${newName}`);

      return reply.send({
        success: true,
        message: 'File rinominato con successo',
      });
    } catch (error) {
      console.error('[FILE] ❌ Errore rinomina file:', error);
      return reply.code(500).send({
        error: 'Errore durante la rinominazione del file',
        message: error.message,
      });
    }
  });

  /**
   * PUT /archive/documents/move
   * Sposta un file in un'altra cartella
   */
  fastify.put('/documents/move', async (request, reply) => {
    try {
      const { db, documentId, targetFolder } = request.body;

      if (!db || !documentId) {
        return reply.code(400).send({ error: 'Parametri "db" e "documentId" obbligatori' });
      }

      const documentRepo = new DocumentRepository(fastify.pg);
      const document = await documentRepo.findById(documentId);

      if (!document || document.db !== db) {
        return reply.code(404).send({ error: 'Documento non trovato' });
      }

      // Calcola nuovo percorso
      const newFolderPath = targetFolder || '';
      const newFolderPathArray = newFolderPath ? newFolderPath.split('/').filter(Boolean) : [];
      const newParentFolder = newFolderPathArray.length > 0 ? newFolderPathArray[newFolderPathArray.length - 1] : null;

      // Sposta fisicamente il file se storage locale
      if (USE_LOCAL_STORAGE && document.storage_path) {
        const oldFullPath = path.join(LOCAL_STORAGE_PATH, document.storage_path);
        const filename = path.basename(document.storage_path);
        const newObjectName = `${db}/${newFolderPath ? `${newFolderPath}/` : ''}${Date.now()}_${filename}`;
        const newFullPath = path.join(LOCAL_STORAGE_PATH, newObjectName);

        try {
          // Crea directory se non esiste
          await fs.mkdir(path.dirname(newFullPath), { recursive: true });
          // Sposta il file
          await fs.rename(oldFullPath, newFullPath);
          // Aggiorna storage_path
          await documentRepo.update(documentId, {
            storage_path: newObjectName,
          });
          console.log(`[FILE] ✅ File spostato: ${oldFullPath} -> ${newFullPath}`);
        } catch (err) {
          console.error('[FILE] ❌ Errore spostamento file fisico:', err);
          // Continua comunque per aggiornare il DB
        }
      }

      // Aggiorna metadati nel DB
      await documentRepo.update(documentId, {
        folder_path: newFolderPath,
        folder_path_array: newFolderPathArray,
        parent_folder: newParentFolder,
      });

      console.log(`[FILE] ✅ File spostato nel DB: ${documentId} -> ${targetFolder || 'root'}`);

      return reply.send({
        success: true,
        message: 'File spostato con successo',
      });
    } catch (error) {
      console.error('[FILE] ❌ Errore spostamento file:', error);
      return reply.code(500).send({
        error: 'Errore durante lo spostamento del file',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/documents/:id/download
   * Download di un file
   */
  fastify.get('/documents/:id/download', async (request, reply) => {
    try {
      const { id } = request.params;
      const { db } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const documentRepo = new DocumentRepository(fastify.pg);
      const document = await documentRepo.findById(id);

      if (!document || document.db !== db) {
        return reply.code(404).send({ error: 'Documento non trovato' });
      }

      if (USE_LOCAL_STORAGE) {
        const filePath = path.join(LOCAL_STORAGE_PATH, document.storage_path);

        // Verifica che il file esista
        try {
          await fs.access(filePath);
        } catch {
          return reply.code(404).send({ error: 'File non trovato sul disco' });
        }

        // Determina mime type
        const ext = path.extname(document.original_filename).toLowerCase();
        const mimeTypes = {
          '.pdf': 'application/pdf',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.doc': 'application/msword',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xls': 'application/vnd.ms-excel',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.txt': 'text/plain',
          '.zip': 'application/zip',
        };
        const mimeType = mimeTypes[ext] || 'application/octet-stream';

        reply.header('Content-Type', mimeType);
        reply.header('Content-Disposition', `attachment; filename="${document.original_filename}"`);

        const fileStream = await fs.readFile(filePath);
        return reply.send(fileStream);
      } else {
        // Per MinIO, genera URL presigned
        const storageReady = await ensureArchiveBucketReady();
        if (!storageReady) {
          return reply.code(503).send({ error: 'Storage non disponibile' });
        }

        const presignedUrl = await minioClient.presignedGetObject(bucketName, document.storage_path, 60 * 60); // 1 ora
        return reply.send({ downloadUrl: presignedUrl });
      }
    } catch (error) {
      console.error('[FILE] ❌ Errore download file:', error);
      return reply.code(500).send({
        error: 'Errore durante il download del file',
        message: error.message,
      });
    }
  });

  /**
   * POST /archive/documents/:id/retry
   * Riprova il processamento di un documento fallito
   */
  fastify.post('/documents/:id/retry', async (request, reply) => {
    let boss = null;
    try {
      const { id } = request.params;
      const { db } = request.body;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const documentRepo = new DocumentRepository(fastify.pg);
      const document = await documentRepo.findById(id);

      if (!document || document.db !== db) {
        return reply.code(404).send({ error: 'Documento non trovato' });
      }

      // Solo documenti in stato 'failed' o 'pending' possono essere ritentati
      const retryableStatuses = ['failed', 'pending', 'ocr_completed', 'metadata_completed', 'cleaning_completed'];
      if (!retryableStatuses.includes(document.processing_status)) {
        return reply.code(409).send({
          error: 'Stato non valido',
          message: `Impossibile ritentare: lo stato attuale è "${document.processing_status}". Solo documenti falliti o in attesa possono essere ritentati.`,
          currentStatus: document.processing_status,
        });
      }

      // Resetta il documento per il nuovo tentativo
      await documentRepo.resetForRetry(id);

      // Usa il singleton pg-boss (non creare/distruggere ad ogni richiesta)
      boss = await getBoss(process.env.POSTGRES_URL);

      // Verifica che il queue esista
      await boss.createQueue('archive-ocr');

      // Accoda nuovo job OCR
      const jobId = await boss.send('archive-ocr', {
        documentId: document.id,
        db: db,
      }, {
        priority: document.priority === 'URGENT' ? 100 : 50,
        retryLimit: 3,
        retryDelay: 30,
        expireInMinutes: 60,
      });

      console.log(`[RETRY] Documento ${id} resettato e job OCR accodato: ${jobId}`);

      return reply.send({
        success: true,
        message: 'Documento rimesso in coda per il processamento',
        jobId,
        document: {
          id: document.id,
          status: 'pending',
          originalStatus: document.processing_status,
        },
      });
    } catch (error) {
      console.error('[RETRY] Errore:', error);
      return reply.code(500).send({
        error: 'Errore durante il retry del documento',
        message: error.message,
      });
    }
    // Il singleton pg-boss NON va mai fermato nelle routes
  });

  /**
   * GET /archive/breadcrumb
   * Ottiene il percorso breadcrumb per navigazione
   */
  fastify.get('/breadcrumb', async (request, reply) => {
    try {
      const { path = '' } = request.query;

      if (!path) {
        return reply.send({
          success: true,
          breadcrumb: [{ name: 'Root', path: '' }],
        });
      }

      const parts = path.split('/').filter(Boolean);
      const breadcrumb = [{ name: 'Root', path: '' }];

      let currentPath = '';
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        breadcrumb.push({
          name: part,
          path: currentPath,
        });
      }

      return reply.send({
        success: true,
        breadcrumb,
      });
    } catch (error) {
      console.error('Errore generazione breadcrumb:', error);
      return reply.code(500).send({
        error: 'Errore durante la generazione del breadcrumb',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/stats
   * Statistiche archivio
   */
  fastify.get('/stats', async (request, reply) => {
    try {
      const { db } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const documentRepo = new DocumentRepository(fastify.pg);
      const jobRepo = new JobRepository(fastify.pg);

      // Conta documenti per stato
      const statusCounts = await Promise.all([
        documentRepo.countByDatabase(db, { status: 'pending' }),
        documentRepo.countByDatabase(db, { status: 'completed' }),
        documentRepo.countByDatabase(db, { status: 'failed' }),
      ]);

      const jobStats = await jobRepo.getJobStats({ fromDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) });

      return reply.send({
        success: true,
        stats: {
          documents: {
            pending: statusCounts[0],
            completed: statusCounts[1],
            failed: statusCounts[2],
            total: statusCounts[0] + statusCounts[1] + statusCounts[2],
          },
          jobs: jobStats,
        },
      });
    } catch (error) {
      console.error('Errore recupero statistiche:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero delle statistiche',
        message: error.message,
      });
    }
  });
  
  /**
   * GET /archive/files/:db/:timestamp_:filename
   * Serve i file salvati localmente (quando USE_LOCAL_STORAGE = true)
   */
  if (USE_LOCAL_STORAGE) {
    fastify.get('/files/*', async (request, reply) => {
      try {
        const filePath = request.params['*']; // Es: "studio_cantini/123456_file.pdf"
        const fullPath = path.join(LOCAL_STORAGE_PATH, filePath);

        // Verifica che il file esista
        try {
          await fs.access(fullPath);
        } catch (err) {
          return reply.code(404).send({
            error: 'File non trovato',
            message: 'Il file richiesto non esiste',
          });
        }

        // Determina il mime type dal nome file
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.pdf': 'application/pdf',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.doc': 'application/msword',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xls': 'application/vnd.ms-excel',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.txt': 'text/plain',
          '.zip': 'application/zip',
        };

        const mimeType = mimeTypes[ext] || 'application/octet-stream';

        // Invia il file
        reply.header('Content-Type', mimeType);
        reply.header('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);

        const fileStream = await fs.readFile(fullPath);
        return reply.send(fileStream);

      } catch (error) {
        console.error('Errore serving file:', error);
        return reply.code(500).send({
          error: 'Errore durante il recupero del file',
          message: error.message,
        });
      }
    });
  }

  /**
   * POST /archive/ask
   * Interroga l'LLM con contesto dai documenti
   */
  fastify.post('/ask', async (request, reply) => {
    try {
      const { prompt, model = 'mistral-nemo' } = request.body;

      if (!prompt) {
        return reply.code(400).send({ error: 'Parametro "prompt" obbligatorio' });
      }

      const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';

      console.log('[ASK] Chiamata Ollama:', { model, promptLength: prompt.length });

      const response = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 500,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ASK] Errore Ollama:', response.status, errorText);
        return reply.code(503).send({
          error: 'Errore durante la generazione della risposta',
          message: `Ollama error: ${response.status}`,
        });
      }

      const result = await response.json();

      return reply.send({
        success: true,
        response: result.response,
        model,
        done: result.done,
      });
    } catch (error) {
      console.error('[ASK] Errore:', error);
      return reply.code(500).send({
        error: 'Errore durante la generazione della risposta',
        message: error.message,
      });
    }
  });

  /**
   * DELETE /archive/documents/clear-all
   * Elimina TUTTI i documenti dall'archivio (operazione distruttiva)
   * Richiede: autenticazione JWT + header X-Confirm-Dangerous-Operation
   */
  fastify.delete('/documents/clear-all', async (request, reply) => {
    try {
      const { db } = request.body;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      // Sicurezza: richiede header di conferma esplicita (difesa contro CSRF)
      const confirmHeader = request.headers['x-confirm-dangerous-operation'];
      if (confirmHeader !== 'DELETE_ALL_DOCUMENTS') {
        return reply.code(403).send({
          error: 'Conferma richiesta',
          message: 'Aggiungere header: X-Confirm-Dangerous-Operation: DELETE_ALL_DOCUMENTS',
        });
      }

      // Log audit
      fastify.log.warn({
        user: request.user?.id || request.user?.email || 'unknown',
        db,
        action: 'CLEAR_ALL_DOCUMENTS',
      }, 'AUDIT: Richiesta cancellazione massiva documenti');

      const documentRepo = new DocumentRepository(fastify.pg);

      // Conta documenti prima della cancellazione
      const countBefore = await documentRepo.countByDatabase(db);

      if (countBefore === 0) {
        return reply.send({
          success: true,
          message: 'Nessun documento da eliminare',
          deletedCount: 0,
        });
      }

      // Cancella file fisici da MinIO/storage locale
      const docs = await documentRepo.findByDatabase(db, { limit: 10000 });
      let deletedFiles = 0;
      let deletedFilesErrors = [];

      for (const doc of docs) {
        if (!doc.storage_path) continue;

        try {
          if (!USE_LOCAL_STORAGE && minioClient) {
            const storageReady = await ensureArchiveBucketReady();
            if (storageReady) {
              await minioClient.removeObject(bucketName, doc.storage_path);
              deletedFiles++;
            }
          } else if (USE_LOCAL_STORAGE) {
            const fullPath = path.join(LOCAL_STORAGE_PATH, doc.storage_path);
            await fs.unlink(fullPath);
            deletedFiles++;
          }
        } catch (fileErr) {
          console.error(`[CLEAR-ALL] Errore eliminazione file ${doc.storage_path}:`, fileErr.message);
          deletedFilesErrors.push({ file: doc.storage_path, error: fileErr.message });
        }
      }

      // Cancella jobs da pg-boss usando il singleton
      let deletedJobs = 0;
      try {
        const boss = await getBoss(process.env.POSTGRES_URL);
        // Cancella tutti i jobs archive-*
        const deleted = await boss.getDb().executeSql(
          "DELETE FROM pgboss.job WHERE name LIKE 'archive-%' RETURNING id"
        );
        deletedJobs = deleted?.rows?.length || 0;
      } catch (bossErr) {
        console.error('[CLEAR-ALL] Errore cancellazione jobs pg-boss:', bossErr.message);
      }

      // TRUNCATE della tabella (cascata su chunks e processing_jobs)
      await fastify.pg.query('TRUNCATE TABLE archive_documents CASCADE');

      console.log(`[CLEAR-ALL] Eliminati ${countBefore} documenti, ${deletedFiles} file fisici, ${deletedJobs} jobs`);

      return reply.send({
        success: true,
        message: `Eliminati ${countBefore} documenti dall'archivio`,
        deletedCount: countBefore,
        deletedFiles,
        deletedJobs,
        errors: deletedFilesErrors.length > 0 ? deletedFilesErrors : undefined,
      });

    } catch (error) {
      console.error('[CLEAR-ALL] Errore:', error);
      return reply.code(500).send({
        error: 'Errore durante la cancellazione dei documenti',
        message: error.message,
      });
    }
  });

  // =============================================================================
  // CHAT CONVERSAZIONALE - Endpoints per assistente documentale
  // =============================================================================

  const chatRepo = new ChatRepository(fastify.pg);
  const qdrantClient = new QdrantClient({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
  });

  /**
   * Factory per HybridSearchService con firma corretta.
   * Crea un wrapper Ollama compatibile con l'interfaccia del service.
   */
  function createHybridSearchService() {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const embeddingModel = process.env.EMBEDDING_MODEL || 'bge-m3:latest';

    // Wrapper fetch-based compatibile con l'interfaccia ollama.embeddings()
    const ollamaClient = {
      embeddings: async ({ model, prompt }) => {
        const res = await fetch(`${ollamaUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt }),
        });
        if (!res.ok) throw new Error(`Ollama embeddings error: ${res.statusText}`);
        return res.json(); // { embedding: float[] }
      },
    };

    return new HybridSearchService({
      pgPool: fastify.pg,
      qdrantClient,
      ollamaClient,
      config: {
        embeddingModel,
        qdrantCollection: 'archive_document_chunks',
        fusionMethod: 'rrf',
        weights: {
          fullText: parseFloat(process.env.KEYWORD_WEIGHT || '0.3'),
          semantic: parseFloat(process.env.SEMANTIC_WEIGHT || '0.7'),
        },
      },
    });
  }

  /**
   * POST /archive/chat/sessions
   * Crea una nuova sessione di chat
   */
  fastify.post('/chat/sessions', async (request, reply) => {
    try {
      const { db, title } = request.body;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const session = await chatRepo.createSession(db, null, title);
      console.log(`[CHAT] Nuova sessione creata: ${session.id}`);

      return reply.send({
        success: true,
        session: {
          id: session.id,
          title: session.title,
          created_at: session.created_at,
        },
      });
    } catch (error) {
      console.error('[CHAT] Errore creazione sessione:', error);
      return reply.code(500).send({
        error: 'Errore durante la creazione della sessione',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/chat/sessions
   * Lista sessioni di chat per database
   */
  fastify.get('/chat/sessions', async (request, reply) => {
    try {
      const { db } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const sessions = await chatRepo.listSessions(db);

      return reply.send({
        success: true,
        sessions: sessions.map(s => ({
          id: s.id,
          title: s.title,
          created_at: s.created_at,
          last_message_at: s.last_message_at,
          last_message_preview: s.last_message_preview,
        })),
      });
    } catch (error) {
      console.error('[CHAT] Errore recupero sessioni:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero delle sessioni',
        message: error.message,
      });
    }
  });

  /**
   * GET /archive/chat/sessions/:id/messages
   * Recupera messaggi di una sessione
   */
  fastify.get('/chat/sessions/:id/messages', async (request, reply) => {
    try {
      const { id } = request.params;
      const { db } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const session = await chatRepo.findSessionById(id);
      if (!session || session.db !== db) {
        return reply.code(404).send({ error: 'Sessione non trovata' });
      }

      const messages = await chatRepo.getSessionHistory(id, 100);

      return reply.send({
        success: true,
        session: {
          id: session.id,
          title: session.title,
          created_at: session.created_at,
        },
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          sources: m.sources,
          created_at: m.created_at,
        })),
      });
    } catch (error) {
      console.error('[CHAT] Errore recupero messaggi:', error);
      return reply.code(500).send({
        error: 'Errore durante il recupero dei messaggi',
        message: error.message,
      });
    }
  });

  /**
   * POST /archive/chat/sessions/:id/messages
   * Invia un messaggio e riceve risposta con contesto conversazionale
   */
  fastify.post('/chat/sessions/:id/messages', async (request, reply) => {
    const startTime = Date.now();
    try {
      const { id: sessionId } = request.params;
      const { db, message } = request.body;

      if (!db || !message) {
        return reply.code(400).send({
          error: 'Parametri obbligatori: db, message'
        });
      }

      const session = await chatRepo.findSessionById(sessionId);
      if (!session || session.db !== db) {
        return reply.code(404).send({ error: 'Sessione non trovata' });
      }

      // 1. Salva messaggio utente
      await chatRepo.saveMessage(sessionId, 'user', message);

      // 2. Recupera storico conversazione (ultimi 6 messaggi = 3 scambi)
      const recentMessages = await chatRepo.getRecentMessages(sessionId, 6);

      // 3. Ricerca vettoriale nel contesto della conversazione
      const hybridSearch = createHybridSearchService();
      const searchResults = await hybridSearch.search({
        db,
        query: message,
        semanticWeight: 0.7,
        keywordWeight: 0.3,
        limit: 5,
      });

      // 4. Costruisci contesto per LLM
      const contextChunks = searchResults.results.map(r => ({
        text: r.chunk_text,
        document: r.original_filename,
        score: r.final_score,
      }));

      // 5. Costruisci prompt con memoria conversazionale
      const conversationHistory = recentMessages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content }));

      const systemPrompt = `Sei un assistente documentale intelligente per uno studio professionale.

REGOLE FONDAMENTALI:
1. Rispondi in italiano, in modo professionale ma naturale
2. Usa SOLO le informazioni fornite nel contesto documentale
3. Se non trovi informazioni pertinenti, dillo chiaramente: "Non ho trovato documenti che rispondano alla tua domanda"
4. Cita sempre le fonti usando [Documento: nome_file]
5. Se l'utente fa riferimento a "questo documento", "il rapportino", "quella fattura", etc., cerca nel contesto conversazione precedente

CONTESTO DOCUMENTALE:
${contextChunks.map(c => `[Documento: ${c.document}]\n${c.text.substring(0, 800)}...`).join('\n\n---\n\n')}

STORICO CONVERSAZIONE (dalla più recente):
${conversationHistory.map(m => `${m.role === 'user' ? 'Utente' : 'Assistente'}: ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`).join('\n')}`;

      // 6. Chiama Ollama
      const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
      const ollamaResponse = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OLLAMA_CHAT_MODEL || 'llama3.2',
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversationHistory.slice(-4), // Ultimi 2 scambi per contesto
            { role: 'user', content: message },
          ],
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 800,
          },
        }),
      });

      if (!ollamaResponse.ok) {
        throw new Error(`Ollama error: ${ollamaResponse.status}`);
      }

      const ollamaData = await ollamaResponse.json();
      const assistantResponse = ollamaData.message?.content || 'Mi dispiace, non sono riuscito a elaborare la risposta.';

      // 7. Salva risposta con fonti
      const sources = searchResults.results.map(r => ({
        document_id: r.document_id,
        filename: r.original_filename,
        chunk_id: r.chunk_id,
        score: r.final_score,
      }));

      await chatRepo.saveMessage(
        sessionId,
        'assistant',
        assistantResponse,
        sources,
        ollamaData.eval_count || null
      );

      // 8. Aggiorna titolo se è la prima domanda
      const messageCount = await chatRepo.countMessages(sessionId);
      if (messageCount <= 2 && session.title === 'Nuova conversazione') {
        // Genera titolo automatico dalla prima domanda
        const shortTitle = message.length > 40 ? message.substring(0, 40) + '...' : message;
        await chatRepo.updateSessionTitle(sessionId, shortTitle);
      }

      const duration = Date.now() - startTime;
      console.log(`[CHAT] Risposta generata in ${duration}ms per sessione ${sessionId}`);

      return reply.send({
        success: true,
        response: assistantResponse,
        sources: sources.slice(0, 3), // Prime 3 fonti più rilevanti
        timing: { total_ms: duration },
      });

    } catch (error) {
      console.error('[CHAT] Errore elaborazione messaggio:', error);
      return reply.code(500).send({
        error: 'Errore durante l\'elaborazione del messaggio',
        message: error.message,
      });
    }
  });

  /**
   * DELETE /archive/chat/sessions/:id
   * Elimina una sessione di chat
   */
  fastify.delete('/chat/sessions/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { db } = request.query;

      if (!db) {
        return reply.code(400).send({ error: 'Parametro "db" obbligatorio' });
      }

      const session = await chatRepo.findSessionById(id);
      if (!session || session.db !== db) {
        return reply.code(404).send({ error: 'Sessione non trovata' });
      }

      await chatRepo.deleteSession(id);
      console.log(`[CHAT] Sessione eliminata: ${id}`);

      return reply.send({
        success: true,
        message: 'Sessione eliminata',
      });
    } catch (error) {
      console.error('[CHAT] Errore eliminazione sessione:', error);
      return reply.code(500).send({
        error: 'Errore durante l\'eliminazione della sessione',
        message: error.message,
      });
    }
  });
};

export default archiveRoutes;
