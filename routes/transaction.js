import * as Minio from 'minio';
import { ConvertExcelToJson, detectPaymentMethod, parseDate } from '../lib/utils.js';

const transaction = async (fastify) => {
  async function ensureBucketExists(minioClient, bucketName) {
    // ...existing code...
  }

  fastify.get('/:db', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db } = request.params;

    const query = `
      SELECT
        t.id,
        to_char(t.date, 'YYYY-MM-DD') AS date,
        t.amount,
        t.categoryId,
        t.subjectId,
        t.detailId,
        t.ownerId,
        c.name AS categoryName,
        s.name AS subjectName,
        d.name AS detailName,
        o.name AS ownerName,
        t.description,
        t.note,
        t.paymenttype,
        t.status,
        t.excluded_from_stats,
        array_agg(doc.url) FILTER (WHERE doc.url IS NOT NULL) AS documents
      FROM transactions t
      JOIN categories c ON t.categoryId = c.id
      JOIN subjects s ON t.subjectId = s.id
      LEFT JOIN details d ON t.detailId = d.id
      JOIN owners o ON t.ownerId = o.id
      LEFT JOIN documents doc ON doc.transaction_id = t.id
      WHERE t.db = $1
      GROUP BY
        t.id,
        t.date,
        t.amount,
        t.categoryId,
        t.subjectId,
        t.detailId,
        t.ownerId,
        c.name,
        s.name,
        d.name,
        o.name,
        t.description,
        t.note,
        t.paymenttype,
        t.status,
        t.excluded_from_stats
      ORDER BY t.date DESC;
    `;
    const values = [db];

    const { rows } = await fastify.pg.query(query, values);


    try {
      reply.send(rows);
    } catch (error) {
      return reply.code(400).send({ message: error, status: 400 });
    }
  });

  fastify.post('/edit', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const {
        id,
        owner,
        date,
        amount,
        description,
        paymentType,
        note,
        category,
        subject,
        details,
        status,
        db,
        documents,
        excludedFromStats,
      } = request.body;

      const query = `
      SELECT 
        t.id,
        array_agg(doc.url) FILTER (WHERE doc.url IS NOT NULL) AS documentsUrl,
        c.name AS categoryName,
        s.name AS subjectName,
        d.name AS detailName,
        o.name AS ownerName
      FROM transactions t
      JOIN categories c ON t.categoryid = c.id
      JOIN subjects s ON t.subjectid = s.id
      LEFT JOIN details d ON t.detailid = d.id
      JOIN owners o ON t.ownerid = o.id
      LEFT JOIN documents doc ON doc.transaction_id = t.id
      WHERE t.db = $1 AND t.id = $2
      GROUP BY 
        t.id,
        c.name,
        s.name,
        d.name,
        o.name;`

      const values = [db, id];

      const { rows } = await fastify.pg.query(query, values);

      const transaction = rows[0];

      const bucketName = db;
      const bucketTemp = 'file-manager';

      // Verifica che documents sia un array, altrimenti usa array vuoto
      const documentsArray = Array.isArray(documents) ? documents : [];

      if (documentsArray.length === 0) {
        const deleteQuery = `
          DELETE FROM documents
          WHERE transaction_id = $1 AND db = $2;
        `;
        const deleteValues = [id, db];
        await fastify.pg.query(deleteQuery, deleteValues);
      }

      const minioClient = new Minio.Client({
        endPoint: 'minio.studiocantini.inowa.it',
        port: 443,
        useSSL: true,
        accessKey: 'minioAdmin',
        secretKey: 'Inowa2024',
      });

      // Verifica se il bucket esiste, altrimenti lo crea
      await ensureBucketExists(minioClient, bucketName);

      if (transaction.documentsurl && documentsArray.length > 0) {
        const elementsToDelete = transaction.documentsurl.filter(a => !documentsArray.some(b => a === b.url));

        for (const element of elementsToDelete) {
          try {
            const objectName = element.split('/').pop();

            await minioClient.removeObject(bucketName, objectName);

            const deleteQuery = `
              DELETE FROM documents
              WHERE transaction_id = $1 AND db = $2 AND url = $3;
            `;
            const deleteValues = [id, db, element];
            await fastify.pg.query(deleteQuery, deleteValues);
          } catch (error) {
            console.error('Error deleting file', error);
          }
        }
      }

      const getFileNameFromUrl = (url) => url.split('/').pop();

      const documentsList = [];
      for (const document of documentsArray) {
        if (document.isNew) {
          const fileName = getFileNameFromUrl(document.url);
          const url = `${transaction.categoryname}/${transaction.subjectname}/`
          const newObjectName = transaction.detailsname
            ? `${url}${transaction.detailsname}/${fileName}`
            : `${url}${fileName}`
              .replace(/\s+/g, '_');

          const sourceKey = `/temp/${fileName}`;
          // Copia il file nella nuova posizione
          await minioClient.copyObject(bucketName, newObjectName, bucketTemp + sourceKey);

          // Elimina il file originale
          await minioClient.removeObject(bucketTemp, sourceKey);

          // Aggiungi il nuovo URL alla lista
          documentsList.push(`https://minio.studiocantini.inowa.it/${bucketName}/${newObjectName}`);
        }
      }

      try {
        if (documentsList.length > 0) {
          // Inserimento dei documenti associati
          // Supponendo che documents sia un array di url
          for (const doc of documentsList) {
            const insertDocumentQuery = `
            INSERT INTO documents (transaction_id, url, db)
            VALUES ($1, $2, $3);
          `;
            const documentValues = [id, doc, db];
            await fastify.pg.query(insertDocumentQuery, documentValues);
          }
        }

        const query = `
          UPDATE transactions
          SET ownerid = $1, date = $2, amount = $3, description = $4, 
              paymenttype = $5, note = $6, categoryid = $7, subjectid = $8, 
              detailid = $9, status = $10, excluded_from_stats = $11
          WHERE id = $12 AND db = $13
          RETURNING *;
        `;

        const values = [owner, date, amount, description, paymentType, note, category, subject, details === '' ? null : details, status, excludedFromStats || false, id, db];
        await fastify.pg.query(query, values);

        reply.send({ message: 'Record aggiornato con successo', status: 200 });
      } catch (error) {
        console.log('Error fetching data', error);
        return reply.code(400).send({ message: error.message, status: 400 });
      }
    } catch (error) {
      console.error('Error updating owner', error);
    }
  });

  fastify.post('/edit/multi', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db, category, subject, details, transactions, status, paymentType, excludedFromStats } = request.body;

    try {
      for (const t of transactions) {
        let query;
        let values;

        const isPaymentTypeValid = paymentType !== null && paymentType !== '';
        const hasExclusionFlag = excludedFromStats !== undefined && excludedFromStats !== null;

        if (!category) {
          let updateFields = ['status = $1'];
          let paramIndex = 2;
          let queryValues = [status];

          if (isPaymentTypeValid) {
            updateFields.push(`paymenttype = $${paramIndex}`);
            queryValues.push(paymentType);
            paramIndex++;
          }

          if (hasExclusionFlag) {
            updateFields.push(`excluded_from_stats = $${paramIndex}`);
            queryValues.push(excludedFromStats);
            paramIndex++;
          }

          query = `
            UPDATE transactions
            SET ${updateFields.join(', ')}
            WHERE id = $${paramIndex} AND db = $${paramIndex + 1}
            RETURNING *;
          `;
          values = [...queryValues, t, db];
        } else {
          let updateFields = [
            'categoryid = $1', 
            'subjectid = $2', 
            'detailid = $3', 
            'status = $4'
          ];
          let paramIndex = 5;
          let queryValues = [category, subject, details, status];

          if (isPaymentTypeValid) {
            updateFields.push(`paymenttype = $${paramIndex}`);
            queryValues.push(paymentType);
            paramIndex++;
          }

          if (hasExclusionFlag) {
            updateFields.push(`excluded_from_stats = $${paramIndex}`);
            queryValues.push(excludedFromStats);
            paramIndex++;
          }

          query = `
            UPDATE transactions
            SET ${updateFields.join(', ')}
            WHERE id = $${paramIndex} AND db = $${paramIndex + 1}
            RETURNING *;
          `;
          values = [...queryValues, t, db];
        }

        await fastify.pg.query(query, values);
      }

      reply.send({ message: 'Record aggiornati con successo', status: 200 });
    } catch (error) {
      console.error('Error updating transactions', error);
      return reply.code(500).send({ message: 'Errore interno', status: 500 });
    }
  });

  fastify.post('/delete', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { ids } = request.body;

      try {

        for (const id of ids) {
          const query = 'DELETE FROM transactions WHERE id = $1';
          const values = [id];
          await fastify.pg.query(query, values);
        }

        reply.send({ message: 'Record eliminato', status: 200 });
      } catch (error) {
        return reply.code(400).send({ message: error.message, status: 400 });
      }
    } catch (error) {
      console.error('Error deleting record', error);
    }
  });

  fastify.post('/filtered_list', { preHandler: fastify.authenticate }, async (request, reply) => {
    const { db, owner, category, subject, details, year } = request.body;

    try {
      // Handle the special case for "all-accounts"
      const isAllAccounts = owner === 'all-accounts';

      // Gestione del caso 'all-years'
      const hasYearFilter = year && year !== 'all-years';
      const yearValue = hasYearFilter ? parseInt(year) : null;

      const query = `
        SELECT
          to_char(t.date, 'YYYY-MM-DD') AS date,
          t.amount,
          o.name AS ownerName,
          t.description
        FROM
          transactions t
        JOIN
          categories c ON t.categoryId = c.id
        JOIN
          subjects s ON t.subjectId = s.id
        LEFT JOIN
          details d ON t.detailId = d.id
        JOIN
          owners o ON t.ownerId = o.id
        WHERE
          t.db = $1
          ${isAllAccounts ? '' : 'AND t.ownerId = $2'}
          AND t.categoryId = ${isAllAccounts ? '$2' : '$3'}
          AND t.subjectId = ${isAllAccounts ? '$3' : '$4'}
          ${details ? `AND t.detailId = $${isAllAccounts ? '4' : '5'}` : ''}
          ${hasYearFilter ? `AND EXTRACT(YEAR FROM t.date) = $${isAllAccounts ? (details ? '5' : '4') : (details ? '6' : '5')}` : ''}
      `;

      const values = isAllAccounts
        ? (details
            ? (hasYearFilter ? [db, category, subject, details, yearValue] : [db, category, subject, details])
            : (hasYearFilter ? [db, category, subject, yearValue] : [db, category, subject]))
        : (details
            ? (hasYearFilter ? [db, owner, category, subject, details, yearValue] : [db, owner, category, subject, details])
            : (hasYearFilter ? [db, owner, category, subject, yearValue] : [db, owner, category, subject]));

      const { rows } = await fastify.pg.query(query, values);

      reply.send({ data: rows });
    } catch (error) {
      console.error('Error fetching data', error);
      reply.status(500).send({ error: 'Failed to fetch data' });
    }
  });

  fastify.post('/split', { preHandler: fastify.authenticate }, async (request, reply) => {
    const {
      db,
      id,
      date,
      amount,
      description,
      details,
      documents,
      note,
      owner,
      paymentType,
      status,
      subject,
      category,
    } = request.body;

    try {
      const selectQuery = `SELECT * FROM transactions WHERE id = $1 AND db = $2;`;
      const selectValues = [id, db];

      const { rows } = await fastify.pg.query(selectQuery, selectValues);

      const originalTransaction = rows[0];

      // Fix: Calcolo corretto del rimanente dopo lo scorporo con arrotondamento a 2 cifre decimali
      // Il rimanente è sempre: importo originale - importo scorporato
      const updatedAmount = Math.round((originalTransaction.amount - amount) * 100) / 100;

      const updateQuery = `
          UPDATE transactions
          SET amount = $3
          WHERE id = $1 AND db = $2
          RETURNING *;
        `;

      const updateValues = [id, db, updatedAmount];
      await fastify.pg.query(updateQuery, updateValues);

      const insertQuery = `
        INSERT INTO transactions (db, amount, categoryId, subjectId, detailId, ownerId, date, description,  note, paymenttype, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *;
      `;

      // Arrotonda anche l'amount da inserire a 2 cifre decimali
      const roundedAmount = Math.round(amount * 100) / 100;
      const insertValues = [db, roundedAmount, category, subject, details, owner, date, description, note, paymentType, status];

      await fastify.pg.query(insertQuery, insertValues);
      
      // La transazione originale mantiene il suo status originale
      // Se necessario, potrebbe essere aggiornato in futuro con logica specifica

      reply.send({ message: 'Record inserito correttamente' }).code(200);
    } catch (error) {
      console.error('Error fetching data', error);
      reply.status(500).send({ error: 'Failed to fetch data' });
    }
  });

  fastify.post('/create', { preHandler: fastify.authenticate }, async (request, reply) => {
    const {
      amount,
      category,
      date,
      db,
      description,
      details,
      note,
      owner,
      paymentType,
      status,
      subject,
      documents, // Array di documenti con flag isNew e url
    } = request.body;

    try {
      const insertQuery = `
      INSERT INTO transactions (db, amount, categoryId, subjectId, detailId, ownerId, date, description, note, paymenttype, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `;
      const values = [db, amount, category, subject, details, owner, date, description, note, paymentType, status];
      const { rows } = await fastify.pg.query(insertQuery, values);
      const transaction = rows[0];

      // Gestione dei documenti
      const minioClient = new Minio.Client({
        endPoint: 'minio.studiocantini.inowa.it',
        port: 443,
        useSSL: true,
        accessKey: 'minioAdmin',
        secretKey: 'Inowa2024',
      });
      // Verifica l'esistenza del bucket principale
      await ensureBucketExists(minioClient, db);
      const bucketName = db;
      const bucketTemp = 'file-manager';

      const getFileNameFromUrl = (url) => url.split('/').pop();

      let documentsList = [];
      if (documents && documents.length > 0) {
        for (const document of documents) {
          if (document.isNew) {
            const fileName = getFileNameFromUrl(document.url);
            // Costruisce il percorso in base a category, subject ed eventualmente detail
            const basePath = `${transaction.categoryname}/${transaction.subjectname}/`;
            const newObjectName = transaction.detailname
              ? `${basePath}${transaction.detailname}/${fileName}`
              : `${basePath}${fileName}`.replace(/\s+/g, '_');
            const sourceKey = `/temp/${fileName}`;

            // Copia il file dalla posizione temporanea a quella definitiva e rimuove l'originale
            await minioClient.copyObject(bucketName, newObjectName, bucketTemp + sourceKey);
            await minioClient.removeObject(bucketTemp, sourceKey);

            documentsList.push(`https://minio.studiocantini.inowa.it/${bucketName}/${newObjectName}`);
          }
        }
        // Inserisce i documenti nella tabella
        if (documentsList.length > 0) {
          for (const docUrl of documentsList) {
            const insertDocumentQuery = `
            INSERT INTO documents (transaction_id, url, db)
            VALUES ($1, $2, $3);
          `;
            const documentValues = [transaction.id, docUrl, db];
            await fastify.pg.query(insertDocumentQuery, documentValues);
          }
        }
      }

      reply.send({ message: 'Record inserito correttamente', transaction });
    } catch (error) {
      console.error('Error fetching data', error);
      reply.status(500).send({ error: 'Failed to fetch data' });
    }
  });

  // Importazione di transazioni con supporto per il tracciamento dei batch
  fastify.post('/import', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      console.log('📂 Inizio importazione batch...');
      
      const file = await request.file();
      const bufferedFile = await file.toBuffer();
      console.log('✅ File ricevuto!');

      const { db, owner, category, subject, details } = JSON.parse(file.fields.metadata.value);
      console.log('📊 Metadata ricevuti:', { db, owner, category, subject, details });

      // Estrae i dati dal file Excel
      const excelToJson = ConvertExcelToJson(bufferedFile);
      console.log('📋 Dati estratti dal file:', excelToJson);

      if (!excelToJson || excelToJson.length === 0) {
        console.warn('⚠️ Nessun dato estratto dal file!');
        return reply.status(400).send({ error: 'Il file non contiene transazioni valide' });
      }

      // Inizia una transazione per garantire l'atomicità delle operazioni
      const client = await fastify.pg.connect();
      
      try {
        await client.query('BEGIN');
        
        // 1. Crea un record nella tabella import_batches
        const createBatchQuery = `
          INSERT INTO import_batches (db, owner_id, category_id, subject_id, detail_id, filename, file_size)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `;
        
        const batchValues = [
          db, 
          owner, 
          category, 
          subject, 
          details || null, 
          file.filename || 'imported_file.xlsx', 
          file.file?.bytesRead || 0
        ];
        
        const batchResult = await client.query(createBatchQuery, batchValues);
        const batchId = batchResult.rows[0].id;
        
        console.log('🆔 Batch di importazione creato con ID:', batchId);
        
        // 2. Elabora ogni transazione dal file
        const transactions = [];
        
        for (const transaction of excelToJson) {
          const { date, description, negativeAmount, positiveAmount, paymentType } = transaction;
          
          // Determina l'importo
          let amount;
          if (negativeAmount && parseFloat(negativeAmount) !== 0) {
            amount = parseFloat(negativeAmount);
          } else if (positiveAmount && parseFloat(positiveAmount) !== 0) {
            amount = parseFloat(positiveAmount);
          } else {
            console.warn('⚠️ Transazione senza importo valido, saltata:', transaction);
            continue;
          }
          
          // Determina la data
          let parsedDate;
          try {
            parsedDate = date ? parseDate(date) : new Date();
          } catch (e) {
            console.warn('⚠️ Data non valida, utilizzo data odierna:', date);
            parsedDate = new Date();
          }
          
          // Determina il metodo di pagamento
          const detectedPaymentType = paymentType || detectPaymentMethod(description) || 'Bonifico';
          
          // Inserisci la transazione collegandola al batch
          const insertQuery = `
            INSERT INTO transactions (
              date, description, amount, db, 
              ownerid, categoryid, subjectid, detailid, 
              note, paymenttype, status, import_batch_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id
          `;
          
          const insertValues = [
            parsedDate,
            description || 'Transazione senza descrizione',
            amount,
            db,
            owner,
            category,
            subject,
            details || null,
            '',
            detectedPaymentType,
            'pending',
            batchId
          ];
          
          const result = await client.query(insertQuery, insertValues);
          transactions.push(result.rows[0].id);
          
          console.log('➕ Transazione inserita:', result.rows[0].id);
        }
        
        await client.query('COMMIT');
        
        console.log('✅ Importazione completata con successo! Transazioni create:', transactions.length);
        
        reply.send({ 
          success: true, 
          message: `Import completed successfully. ${transactions.length} transactions created.`,
          batchId,
          transactionCount: transactions.length
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Errore durante l\'importazione, rollback effettuato:', err);
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('❌ Errore generale durante l\'importazione:', error);
      reply.status(500).send({ 
        error: 'Failed to import data', 
        message: error.message 
      });
    }
  });

  // API per ottenere la cronologia delle importazioni
  fastify.post('/import-history', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, limit = 50, offset = 0 } = request.body;

      // Query per ottenere le importazioni raggruppate per batch
      const query = `
        SELECT 
          i.id,
          i.created_at as date,
          i.owner_id,
          i.category_id,
          i.subject_id,
          i.detail_id,
          o.name as owner_name,
          c.name as category_name,
          s.name as subject_name,
          d.name as detail_name,
          0 as transaction_count
        FROM 
          import_batches i
        LEFT JOIN 
          transactions t ON false -- Temporaneamente disabilitato perché la colonna import_batch_id non esiste
        LEFT JOIN
          owners o ON i.owner_id = o.id  
        LEFT JOIN
          categories c ON i.category_id = c.id
        LEFT JOIN
          subjects s ON i.subject_id = s.id
        LEFT JOIN
          details d ON i.detail_id = d.id
        WHERE 
          i.db = $1
        GROUP BY 
          i.id, i.created_at, i.owner_id, i.category_id, i.subject_id, i.detail_id, 
          o.name, c.name, s.name, d.name
        ORDER BY 
          i.created_at DESC
        LIMIT $2 OFFSET $3
      `;
      
      const countQuery = `
        SELECT COUNT(*) as total FROM import_batches WHERE db = $1
      `;
      
      const values = [db, limit, offset];
      const countValues = [db];
      
      // Esegui entrambe le query in parallelo
      const [importResults, countResults] = await Promise.all([
        fastify.pg.query(query, values),
        fastify.pg.query(countQuery, countValues)
      ]);
      
      // Trasforma i risultati per renderli più facili da usare nel frontend
      const imports = importResults.rows.map(row => ({
        id: row.id,
        date: row.date,
        owner: {
          id: row.owner_id,
          name: row.owner_name
        },
        category: {
          id: row.category_id,
          name: row.category_name
        },
        subject: {
          id: row.subject_id,
          name: row.subject_name
        },
        detail: {
          id: row.detail_id,
          name: row.detail_name
        },
        count: parseInt(row.transaction_count, 10)
      }));
      
      const totalCount = parseInt(countResults.rows[0].total, 10);
      
      reply.send({
        imports,
        totalCount
      });
    } catch (error) {
      console.error('Error fetching import history:', error);
      reply.status(500).send({ 
        error: 'Failed to fetch import history',
        message: error.message 
      });
    }
  });

  // API per ottenere i dettagli di un'importazione specifica
  fastify.post('/import-history/details', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, importId } = request.body;
      
      if (!db || !importId) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }
      
      // Query per ottenere tutte le transazioni associate a un batch di importazione
      const query = `
        SELECT 
          t.id,
          to_char(t.date, 'YYYY-MM-DD') AS date,
          t.description,
          t.amount,
          t.categoryId,
          t.subjectId,
          t.detailId,
          c.name AS category_name,
          s.name AS subject_name,
          d.name AS detail_name
        FROM 
          transactions t
        JOIN
          categories c ON t.categoryId = c.id
        JOIN
          subjects s ON t.subjectId = s.id
        LEFT JOIN
          details d ON t.detailId = d.id
        WHERE 
          t.db = $1 AND t.import_batch_id = $2
        ORDER BY 
          t.date DESC
      `;
      
      const values = [db, importId];
      
      const { rows } = await fastify.pg.query(query, values);
      
      // Trasforma i risultati in un formato più adatto per il frontend
      const transactions = rows.map(row => ({
        id: row.id,
        date: row.date,
        description: row.description,
        amount: row.amount,
        category: {
          id: row.categoryid,
          name: row.category_name
        },
        subject: {
          id: row.subjectid,
          name: row.subject_name
        },
        detail: {
          id: row.detailid,
          name: row.detail_name
        }
      }));
      
      reply.send({ transactions });
    } catch (error) {
      console.error('Error fetching import details:', error);
      reply.status(500).send({
        error: 'Failed to fetch import details',
        message: error.message
      });
    }
  });

  // API per annullare un'importazione (eliminare tutte le transazioni di un batch)
  fastify.post('/undo-import', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db, importId, transactionIds } = request.body;
      
      // Verifica che sia stato fornito o l'ID del batch o un array di ID di transazioni
      if (!db || (!importId && (!transactionIds || transactionIds.length === 0))) {
        return reply.status(400).send({ error: 'Missing required parameters' });
      }
      
      // Inizia una transazione per garantire l'atomicità delle operazioni
      const client = await fastify.pg.connect();
      
      try {
        await client.query('BEGIN');
        
        let deletedCount = 0;
        
        if (importId) {
          // Elimina tutte le transazioni associate al batch di importazione
          const deleteDocsQuery = `
            DELETE FROM documents
            WHERE transaction_id IN (
              SELECT id FROM transactions WHERE db = $1 AND import_batch_id = $2
            )
          `;
          
          const deleteTransactionsQuery = `
            DELETE FROM transactions
            WHERE db = $1 AND import_batch_id = $2
            RETURNING id
          `;
          
          const deleteBatchQuery = `
            DELETE FROM import_batches
            WHERE id = $1 AND db = $2
          `;
          
          // Esegui in ordine le eliminazioni per rispettare i vincoli di foreign key
          await client.query(deleteDocsQuery, [db, importId]);
          const deleteResult = await client.query(deleteTransactionsQuery, [db, importId]);
          deletedCount = deleteResult.rowCount;
          await client.query(deleteBatchQuery, [importId, db]);
        } else if (transactionIds && transactionIds.length > 0) {
          // Elimina transazioni specifiche
          const placeholders = transactionIds.map((_, index) => `$${index + 3}`).join(',');
          
          const deleteDocsQuery = `
            DELETE FROM documents
            WHERE transaction_id IN (${placeholders})
          `;
          
          const deleteTransactionsQuery = `
            DELETE FROM transactions
            WHERE db = $1 AND id IN (${placeholders})
            RETURNING id
          `;
          
          // Esegui in ordine le eliminazioni
          await client.query(deleteDocsQuery, [db, ...transactionIds]);
          const deleteResult = await client.query(deleteTransactionsQuery, [db, ...transactionIds]);
          deletedCount = deleteResult.rowCount;
        }
        
        await client.query('COMMIT');
        
        reply.send({
          success: true,
          message: `Import successfully undone. ${deletedCount} transactions deleted.`,
          deletedCount
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error undoing import:', error);
      reply.status(500).send({
        error: 'Failed to undo import',
        message: error.message
      });
    }
  });

  // Route per aggiornare solo il campo excluded_from_stats
  fastify.post('/toggle-stats-exclusion', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id, db, excludedFromStats } = request.body;

      const query = `
        UPDATE transactions
        SET excluded_from_stats = $1
        WHERE id = $2 AND db = $3
        RETURNING id, excluded_from_stats;
      `;

      const values = [excludedFromStats, id, db];
      const { rows } = await fastify.pg.query(query, values);

      if (rows.length === 0) {
        return reply.code(404).send({ message: 'Transaction not found', status: 404 });
      }

      reply.send({ 
        message: 'Stato di esclusione aggiornato con successo', 
        data: rows[0], 
        status: 200 
      });
    } catch (error) {
      console.error('Error updating stats exclusion', error);
      return reply.code(400).send({ message: error.message, status: 400 });
    }
  });

  // Endpoint per salvare il feedback sulle classificazioni AI
  fastify.post('/classification-feedback', { preHandler: fastify.authenticate }, async (request, reply) => {
    const {
      db,
      transactionId,
      originalDescription,
      amount,
      transactionDate,
      suggestedCategoryId,
      suggestedSubjectId,
      suggestedDetailId,
      suggestionConfidence,
      suggestionMethod,
      correctedCategoryId,
      correctedSubjectId,
      correctedDetailId,
    } = request.body;

    try {
      // Verifica che ci sia stata effettivamente una correzione
      const wasCorrection = 
        suggestedCategoryId !== correctedCategoryId ||
        suggestedSubjectId !== correctedSubjectId ||
        suggestedDetailId !== correctedDetailId;

      if (!wasCorrection) {
        // Non è una correzione, l'utente ha accettato il suggerimento così com'è
        return reply.code(200).send({ 
          message: 'No correction needed, suggestion was accepted',
          feedbackSaved: false,
          status: 200 
        });
      }

      // Salva il feedback per future classificazioni
      const insertQuery = `
        INSERT INTO classification_feedback (
          db,
          transaction_id,
          original_description,
          amount,
          transaction_date,
          suggested_category_id,
          suggested_subject_id,
          suggested_detail_id,
          suggestion_confidence,
          suggestion_method,
          corrected_category_id,
          corrected_subject_id,
          corrected_detail_id,
          created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
      `;

      const result = await fastify.pg[db].query(insertQuery, [
        db,
        transactionId,
        originalDescription,
        amount,
        transactionDate,
        suggestedCategoryId,
        suggestedSubjectId,
        suggestedDetailId,
        suggestionConfidence,
        suggestionMethod,
        correctedCategoryId,
        correctedSubjectId,
        correctedDetailId,
        request.user.email,
      ]);

      return reply.code(200).send({ 
        message: 'Classification feedback saved successfully',
        feedbackSaved: true,
        feedbackId: result.rows[0].id,
        status: 200 
      });
    } catch (error) {
      console.error('Error saving classification feedback:', error);
      return reply.code(400).send({ 
        message: error.message, 
        status: 400 
      });
    }
  });

  // L'endpoint per importare un file Excel e associare i movimenti ad una transazione esistente
  // è stato spostato in transaction-import-associated.js
};

export default transaction;
