import * as Minio from 'minio';
import { ConvertExcelToJson, detectPaymentMethod, parseDate } from '../lib/utils.js';

const transaction = async (fastify) => {
  async function ensureBucketExists(minioClient, bucketName) {
    return new Promise((resolve, reject) => {
      minioClient.bucketExists(bucketName, (err, exists) => {
        if (err) return reject(err);
        if (!exists) {
          // Rimuovi il parametro region se non necessario oppure specifica la region desiderata
          minioClient.makeBucket(bucketName, '', (err) => {
            if (err) return reject(err);
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
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
        t.status
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

      if (documents.length === 0) {
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

      if (transaction.documentsurl) {
        const elementsToDelete = transaction.documentsurl.filter(a => !documents.some(b => a === b.url));

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
      for (const document of documents) {
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
              detailid = $9, status = $10
          WHERE id = $11 AND db = $12
          RETURNING *;
        `;

        const values = [owner, date, amount, description, paymentType, note, category, subject, details === '' ? null : details, status, id, db];
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
    const { db, category, subject, details, transactions, status, paymentType } = request.body;

    try {
      for (const t of transactions) {
        let query;
        let values;

        const isPaymentTypeValid = paymentType !== null && paymentType !== '';

        if (!category) {
          query = `
          UPDATE transactions
          SET status = $1
          ${isPaymentTypeValid ? ', paymenttype = $2' : ''}
          WHERE id = $${isPaymentTypeValid ? '3' : '2'} AND db = $${isPaymentTypeValid ? '4' : '3'}
          RETURNING *;
        `;
          values = isPaymentTypeValid ? [status, paymentType, t, db] : [status, t, db];
        } else {
          query = `
          UPDATE transactions
          SET categoryid = $1, 
              subjectid = $2, 
              detailid = $3, 
              status = $4
          ${isPaymentTypeValid ? ', paymenttype = $5' : ''}
          WHERE id = $${isPaymentTypeValid ? '6' : '5'} AND db = $${isPaymentTypeValid ? '7' : '6'}
          RETURNING *;
        `;
          values = isPaymentTypeValid ? [category, subject, details, status, paymentType, t, db] : [category, subject, details, status, t, db];
        }

        // Esegui la query solo se paymentType è valido o non è incluso nella query
        if (isPaymentTypeValid || !query.includes('paymenttype')) {
          await fastify.pg.query(query, values);
        } else {
          // Se paymentType non è valido, aggiorna solo gli altri campi
          query = `
          UPDATE transactions
          SET categoryid = $1, 
              subjectid = $2, 
              detailid = $3, 
              status = $4
          WHERE id = $5 AND db = $6
          RETURNING *;
        `;
          values = [category, subject, details, status, t, db];
          await fastify.pg.query(query, values);
        }
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
          AND EXTRACT(YEAR FROM t.date) = $${isAllAccounts ? (details ? '5' : '4') : (details ? '6' : '5')}
      `;

      const values = isAllAccounts
        ? (details
            ? [db, category, subject, details, parseInt(year)]
            : [db, category, subject, parseInt(year)])
        : (details
            ? [db, owner, category, subject, details, parseInt(year)]
            : [db, owner, category, subject, parseInt(year)]);

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

      const updatedAmount = amount < 0 ? originalTransaction.amount - amount : originalTransaction.amount + amount;

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

      const insertValues = [db, amount, category, subject, details, owner, date, description, note, paymentType, status];

      await fastify.pg.query(insertQuery, insertValues);

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

  fastify.post('/import', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const file = await request.file();
      const bufferedFile = await file.toBuffer();
      const { db, owner, category, subject, details } = JSON.parse(file.fields.metadata.value);

      const excelToJson = ConvertExcelToJson(bufferedFile);

      for (const transaction of excelToJson) {
        const { date, description, negativeAmount, positiveAmount } = transaction;
        // console.log('🔄 Elaborazione transazione:', { description, negativeAmount, positiveAmount });
        const amount = parseFloat((negativeAmount || positiveAmount))
        const paymentType = detectPaymentMethod(description);

        // Converte la data in formato YYYY-MM-DD
        const formattedDate = parseDate(date);
        if (!formattedDate) {
          console.warn(`❌ Data non valida: "${date}"`);
          continue; // Salta la riga se la data non è valida
        }

        // Controlla se il record esiste già
        const { rows } = await fastify.pg.query(`
          SELECT id, status FROM transactions 
          WHERE date = $1::date
            AND description = $2
            AND amount = $3
            AND db = $4
            AND ownerid = $5
        `, [formattedDate, description, amount, db, owner]);

        if (rows.length === 0) {
          // Se non esiste, inserisci il record
          await fastify.pg.query(`
            INSERT INTO transactions (date, description, amount, db, ownerid, categoryid, subjectid, detailid, note, paymenttype, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [formattedDate, description, amount, db, owner, category, subject, details, '', paymentType, 'pending']);
                } else {
                  // Inserisci comunque il record con status imported_duplicate
                  await fastify.pg.query(`
            INSERT INTO transactions (date, description, amount, db, ownerid, categoryid, subjectid, detailid, note, paymenttype, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [formattedDate, description, amount, db, owner, category, subject, details, '', paymentType, 'toCheck']);
        }
      }

      reply.code(200).send({ message: 'Importazione completata con gestione duplicati!' });
    } catch (error) {
      console.error('Error fetching data', error);
      reply.status(500).send({ error: 'Failed to fetch data' });
    }
  });

  fastify.post('/import/associated', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      console.log('📂 Inizio importazione...');

      const file = await request.file();
      const bufferedFile = await file.toBuffer();
      console.log('✅ File ricevuto!');

      const { db, id, commissions } = JSON.parse(file.fields.metadata.value);
      console.log('📊 Metadata ricevuti:', { db, id, commissions });

      const excelToJson = ConvertExcelToJson(bufferedFile);
      console.log('📋 Dati estratti dal file:', excelToJson);

      if (!excelToJson || excelToJson.length === 0) {
        console.warn('⚠️ Nessun dato estratto dal file!');
        return reply.status(400).send({ error: 'Il file non contiene transazioni valide' });
      }

      // 1️⃣ Recupera la data del record originale
      const { rows: selectRows } = await fastify.pg.query(`
            SELECT id, amount, ownerid, categoryid, subjectid, detailid,  TO_CHAR(date, 'YYYY-MM-DD') AS date FROM transactions 
            WHERE id = $1 AND db = $2
        `, [id, db]);

      if (selectRows.length === 0) {
        console.warn('❌ Transazione originale non trovata:', { id, db });
        return reply.status(404).send({ error: 'Transazione originale non trovata' });
      }

      console.log('🔍 Transazione originale trovata:', selectRows[0]);

      const originalDate = selectRows[0].date;
      console.log('📅 Data originale recuperata:', originalDate);

      // Inserisci record commissioni se presente e diverso da 0
      console.log('💳 Commissioni:', commissions)

      if (commissions && parseFloat(commissions) !== 0 && parseFloat(commissions) !== -0) {
        await fastify.pg.query(`
          INSERT INTO transactions (date, description, amount, db, ownerid, categoryid, subjectid, detailid, note, paymenttype, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          originalDate,
          'Commissioni Carta di Credito',
          parseFloat(commissions),
          db,
          selectRows[0].ownerid,
          selectRows[0].categoryid,
          selectRows[0].subjectid,
          selectRows[0].detailid,
          '',
          'Carte di Credito',
          'pending'
        ]);
      }

      const originalAmount = selectRows[0].amount;

      let totalImportedAmount = 0;

      for (const transaction of excelToJson) {
        const { description, negativeAmount, positiveAmount } = transaction;
        let amount;
        if (negativeAmount > 0) {
          amount = parseFloat((negativeAmount * -1).toFixed(2));
        } else {
          amount = parseFloat((negativeAmount || positiveAmount).toFixed(2));
        }
        totalImportedAmount += amount;
        const paymentType = 'Carte di Credito';

        console.log('🔄 Elaborazione transazione:', { description, amount });

        // 2️⃣ Controlla se il record esiste già
        const { rows } = await fastify.pg.query(`
                SELECT id, status FROM transactions 
                WHERE date = $1::date
                  AND description = $2
                  AND amount = $3
                  AND db = $4
            `, [originalDate, description, amount, db]);

        console.log('🔍 Record trovati:', rows);

        // 3️⃣ Inserisci il record con lo stato appropriato
        if (rows.length === 0) {
          // Se non esiste, inserisci con stato 'pending'
          console.log('➕ Inserimento nuovo record');
          await fastify.pg.query(`
            INSERT INTO transactions (date, description, amount, db, ownerid, categoryid, subjectid, detailid, note, paymenttype, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [originalDate, description, amount, db, selectRows[0].ownerid, selectRows[0].categoryid, selectRows[0].subjectid, selectRows[0].detailid, '', paymentType, 'pending']);
        } else {
          // Se esiste già, inserisci con stato 'toCheck'
          console.log('♻️ Record duplicato, inserimento con stato toCheck');
          await fastify.pg.query(`
            INSERT INTO transactions (date, description, amount, db, ownerid, categoryid, subjectid, detailid, note, paymenttype, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [originalDate, description, amount, db, selectRows[0].ownerid, selectRows[0].categoryid, selectRows[0].subjectid, selectRows[0].detailid, '', paymentType, 'toCheck']);
        }
      }

      // Dopo aver elaborato tutti i record, controlla la differenza
      let totalWithCommissions = totalImportedAmount;

      if(commissions) {
        if(typeof commissions === 'string') {
          totalWithCommissions += parseFloat(commissions);
        }else{
          totalWithCommissions += commissions;
        }
      }

      // Arrotonda correttamente per evitare problemi di precisione
      totalWithCommissions = parseFloat(totalWithCommissions.toFixed(2));
      const originalAmountRounded = parseFloat(originalAmount.toFixed(2));

      console.log('📊 Dati di calcolo:');
      console.log('- Importo originale:', originalAmountRounded);
      console.log('- Totale importato:', totalWithCommissions);
      console.log('- Di cui commissioni:', commissions ? parseFloat(commissions) : 0);

      // Calcola la differenza in valore assoluto
      // Nota: gli importi originali e le commissioni sono negativi (spese)
      const diff = parseFloat((originalAmountRounded - totalWithCommissions).toFixed(2));
      console.log('- Differenza calcolata:', diff);

      // Per determinare se è rimanenza o compensazione:
      // - Se l'importo originale è negativo (spesa) e il totale importato è MINORE in valore assoluto
      //   rispetto all'importo originale → Rimanenza
      // - Se l'importo originale è negativo (spesa) e il totale importato è MAGGIORE in valore assoluto
      //   rispetto all'importo originale → Compensazione

      if (diff !== 0) {
        try {
          // Se importo originale è negativo (è una spesa)
          if (originalAmountRounded < 0) {
            // L'importo originale e il totale importato sono entrambi negativi
            // Confrontiamo i valori assoluti
            const absOriginal = Math.abs(originalAmountRounded);
            const absImported = Math.abs(totalWithCommissions);

            if (absImported < absOriginal) {
              // Hai speso MENO rispetto all'importo originale → RIMANENZA
              console.log(`💰 Creazione voce "Rimanenza Carta di Credito" per €${Math.abs(diff)}`);

              const insertQuery = `
                INSERT INTO transactions (date, description, amount, db, ownerid, categoryid, subjectid, detailid, note, paymenttype, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id;
              `;

              const insertParams = [
                selectRows[0].date,
                'Rimanenza Carta di Credito',
                diff, // Rimanenza è negativa perché è la parte non spesa di una somma già addebitata
                db,
                selectRows[0].ownerid,
                selectRows[0].categoryid,
                selectRows[0].subjectid,
                selectRows[0].detailid,
                'Differenza tra addebito originale e spese effettive sulla carta',
                'Carte di Credito',
                'pending'
              ];

              console.log('🔍 Parametri di inserimento:', JSON.stringify(insertParams));

              const { rows: insertResult } = await fastify.pg.query(insertQuery, insertParams);
              console.log('✅ Rimanenza inserita con ID:', insertResult[0]?.id);
            } else {
              // Hai speso PIÙ rispetto all'importo originale → COMPENSAZIONE
              const absDiff = Math.abs(diff); // Rendiamo positivo per chiarezza
              console.log(`💳 Creazione voce "Compensazione da rimanenza carta di credito" per €${absDiff}`);

              const insertQuery = `
                INSERT INTO transactions (date, description, amount, db, ownerid, categoryid, subjectid, detailid, note, paymenttype, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING id;
              `;

              const insertParams = [
                selectRows[0].date,
                'Compensazione da rimanenza carta di credito',
                absDiff, // Compensazione è positiva perché bilancia spese in eccesso
                db,
                selectRows[0].ownerid,
                selectRows[0].categoryid,
                selectRows[0].subjectid,
                selectRows[0].detailid,
                'Compensazione per eccesso di spesa rispetto all\'importo originale (utilizzo di residuo precedente)',
                'Carte di Credito',
                'pending'
              ];

              console.log('🔍 Parametri di inserimento:', JSON.stringify(insertParams));

              const { rows: insertResult } = await fastify.pg.query(insertQuery, insertParams);
              console.log('✅ Compensazione inserita con ID:', insertResult[0]?.id);
            }
          } else {
            // Per completezza gestiamo anche il caso di importo originale positivo
            console.log(`⚠️ Importo originale positivo: ${originalAmountRounded}. Gestione non implementata.`);
          }
        } catch (error) {
          console.error('❌ Errore nell\'inserimento del record di rimanenza/compensazione:', error);
        }
      }

      // 5️⃣ Dopo aver elaborato tutti i record, aggiorna il record originale
      console.log('✔️ Aggiornamento record originale (amount = 0, status = \'completed\')');
      await fastify.pg.query(`
            UPDATE transactions 
            SET status = 'completed', amount = 0 
            WHERE id = $1
        `, [id]);

      console.log('✅ Importazione completata con successo!');
      reply.code(200).send({ message: 'Importazione completata con gestione duplicati!' });

    } catch (error) {
      console.error('❌ ERRORE GENERALE:', error);
      reply.status(500).send({ error: 'Failed to fetch data', details: error.message });
    }
  });
};

export default transaction;
