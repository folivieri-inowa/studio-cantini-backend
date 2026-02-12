// Implementazione dell'endpoint per l'importazione di movimenti associati ad una transazione esistente

import * as Minio from 'minio';
import { ConvertExcelToJson, detectPaymentMethod, parseDate } from '../lib/utils.js';

const transactionImportAssociated = async (fastify) => {
  // Funzione ausiliaria per assicurarsi che il bucket esista
  async function ensureBucketExists(minioClient, bucketName) {
    try {
      const exists = await minioClient.bucketExists(bucketName);
      if (!exists) {
        await minioClient.makeBucket(bucketName);
      }
      return true;
    } catch (err) {
      console.error('Error creating bucket:', err);
      return false;
    }
  }

  // Endpoint per importare un file Excel e associare i movimenti ad una transazione esistente
  fastify.post('/import/associated', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      console.log('📂 Inizio importazione associativa...');
      
      const file = await request.file();
      const bufferedFile = await file.toBuffer();
      console.log('✅ File ricevuto!');

      // Estrai metadata in modo sicuro
      const metadataField = file.fields?.metadata;
      if (!metadataField) {
        console.error('❌ Campo metadata mancante!');
        return reply.status(400).send({ error: 'Missing metadata field' });
      }
      
      // Gestisci sia il caso con .value che senza
      const metadataString = typeof metadataField === 'string' ? metadataField : metadataField.value;
      if (!metadataString) {
        console.error('❌ Valore metadata vuoto!');
        return reply.status(400).send({ error: 'Empty metadata value' });
      }
      
      const { db, id, commissions } = JSON.parse(metadataString);
      console.log('📊 Metadata ricevuti:', { db, id, commissions });

      // Verifica che la transazione principale esista
      const checkQuery = 'SELECT * FROM transactions WHERE id = $1 AND db = $2';
      const checkValues = [id, db];
      const checkResult = await fastify.pg.query(checkQuery, checkValues);
      
      if (checkResult.rowCount === 0) {
        console.warn('⚠️ Transazione principale non trovata!');
        return reply.status(404).send({ error: 'Transazione principale non trovata' });
      }

      const parentTransaction = checkResult.rows[0];
      console.log('✓ Transazione principale trovata:', parentTransaction.id);

      // Estrae i dati dal file Excel
      const excelToJson = await ConvertExcelToJson(bufferedFile);
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
          INSERT INTO import_batches (db, owner_id, category_id, subject_id, detail_id, filename, file_size, parent_transaction_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid)
          RETURNING id
        `;
        
        const batchValues = [
          db, 
          parentTransaction.ownerid, 
          parentTransaction.categoryid, 
          parentTransaction.subjectid, 
          parentTransaction.detailid || null, 
          file.filename, 
          file.file.bytesRead,
          parentTransaction.id
        ];
        
        const batchResult = await client.query(createBatchQuery, batchValues);
        const batchId = batchResult.rows[0].id;
        
        console.log('🆔 Batch di importazione associata creato con ID:', batchId);
        
        // 2. Elabora ogni transazione dal file
        const transactions = [];
        let totalImportedAmount = 0;
        
        // Verifica se è stata specificata una commissione e la aggiunge
        if (commissions && parseFloat(commissions) !== 0) {
          console.log('💰 Commissione specificata:', commissions);
          
          const commissionsAmount = parseFloat(commissions);
          const commissionsDescription = 'Commissione ricarica prepagata';
          
          // Applichiamo il segno corretto alla commissione in base al segno della transazione originale
          const signedCommissionsAmount = Math.sign(parentTransaction.amount) * commissionsAmount;
          
          console.log(`💰 Commissione con segno applicato: ${signedCommissionsAmount}`);
          
          // Inserisci la transazione di commissione
          const insertCommissionQuery = `
            INSERT INTO transactions (
              date, description, amount, db, 
              ownerid, categoryid, subjectid, detailid, 
              note, paymenttype, status, import_batch_id, parent_transaction_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid)
            RETURNING id
          `;
          
          const commissionsValues = [
            parentTransaction.date,
            commissionsDescription,
            signedCommissionsAmount,
            db,
            parentTransaction.ownerid,
            parentTransaction.categoryid,
            parentTransaction.subjectid,
            parentTransaction.detailid || null,
            `Commissione di ricarica associata alla transazione ${parentTransaction.id}`,
            parentTransaction.paymenttype,
            'pending',
            batchId,
            parentTransaction.id
          ];
          
          const commissionsResult = await client.query(insertCommissionQuery, commissionsValues);
          console.log('💰 Transazione di commissione creata:', commissionsResult.rows[0].id);
          
          // Aggiungi la commissione all'array delle transazioni create
          transactions.push(commissionsResult.rows[0].id);
          
          // Includiamo la commissione nel totale importato
          totalImportedAmount += commissionsAmount;
        }
        
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
          
          // Determina la data - Usiamo sempre la data della transazione principale
          const parsedDate = parentTransaction.date;
          
          // Determina il metodo di pagamento
          const detectedPaymentType = paymentType || parentTransaction.paymenttype || detectPaymentMethod(description) || 'Bonifico';
          
          // Inserisci la transazione collegandola al batch e alla transazione principale
          const insertQuery = `
            INSERT INTO transactions (
              date, description, amount, db, 
              ownerid, categoryid, subjectid, detailid, 
              note, paymenttype, status, import_batch_id, parent_transaction_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid)
            RETURNING id
          `;
          
          const insertValues = [
            parsedDate,
            description || 'Commissione associata',
            amount,
            db,
            parentTransaction.ownerid,
            parentTransaction.categoryid,
            parentTransaction.subjectid,
            parentTransaction.detailid || null,
            `Commissione associata alla transazione ${parentTransaction.id}`,
            detectedPaymentType,
            'pending',
            batchId,
            parentTransaction.id
          ];
          
          const result = await client.query(insertQuery, insertValues);
          transactions.push(result.rows[0].id);
          totalImportedAmount += amount;
          
          console.log('➕ Commissione inserita:', result.rows[0].id);
        }
        
        // Verifica che il totale importato corrisponda alla transazione principale
        const parentAmount = Math.abs(parseFloat(parentTransaction.amount));
        const totalAmount = Math.abs(totalImportedAmount);
        const parentSign = Math.sign(parentTransaction.amount); // Conserva il segno della transazione principale
        
        console.log(`📊 Importo transazione principale: ${parentAmount} (segno: ${parentSign})`);
        console.log(`📊 Importo totale commissioni: ${totalAmount}`);
        
        // Calcola la differenza percentuale tra i due importi
        const difference = Math.abs(parentAmount - totalAmount);
        const percentageDifference = (difference / parentAmount) * 100;
        
        if (percentageDifference > 5) {
          console.warn(`⚠️ La differenza tra l'importo della transazione principale (${parentAmount}) e il totale delle commissioni (${totalAmount}) è superiore al 5% (${percentageDifference.toFixed(2)}%)`);
        } else {
          console.log(`✅ Differenza importo accettabile: ${percentageDifference.toFixed(2)}%`);
        }
        
        // Gestione dei tre casi possibili:
        // 1. Gli importi corrispondono (entro una tolleranza del 5%)
        // 2. L'importo totale è inferiore all'importo del record originale
        // 3. L'importo totale è superiore all'importo del record originale
        
        // Azzera sempre l'importo della transazione principale in tutti i casi
        const updateParentQuery = `
          UPDATE transactions
          SET amount = 0
          WHERE id = $1 AND db = $2
          RETURNING id, amount
        `;
        
        const updateResult = await client.query(updateParentQuery, [parentTransaction.id, db]);
        console.log(`✅ Transazione principale azzerata: ${updateResult.rows[0].id}, nuovo importo: ${updateResult.rows[0].amount}`);
        
        if (Math.abs(difference) < 0.01) {
          // CASO 1: Gli importi corrispondono esattamente
          console.log('📋 CASO 1: Gli importi corrispondono esattamente - Nessuna operazione aggiuntiva necessaria');
          
        } else if (totalAmount < parentAmount) {
          // CASO 2: L'importo totale è inferiore all'importo del record originale
          console.log('📋 CASO 2: L\'importo totale è inferiore all\'importo del record originale');
          
          // Calcola la differenza (rimanenza)
          const remainingAmount = parseFloat((parentAmount - totalAmount).toFixed(2));
          console.log(`📊 Rimanenza: ${remainingAmount}`);
          
          // Crea una nuova transazione per la rimanenza
          const createRemainingQuery = `
            INSERT INTO transactions (
              date, description, amount, db, 
              ownerid, categoryid, subjectid, detailid, 
              note, paymenttype, status, import_batch_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id
          `;
          
          const remainingDescription = `${parentTransaction.description} (Rimanenza su carta)`;
          
          // Applichiamo il segno corretto alla rimanenza in base al segno della transazione originale
          const signedRemainingAmount = parentSign * remainingAmount;
          
          const remainingValues = [
            parentTransaction.date,
            remainingDescription,
            signedRemainingAmount,
            db,
            parentTransaction.ownerid,
            parentTransaction.categoryid,
            parentTransaction.subjectid,
            parentTransaction.detailid || null,
            `Rimanenza rispetto alla transazione ${parentTransaction.id}`,
            parentTransaction.paymenttype,
            'pending',
            batchId
          ];
          
          const remainingResult = await client.query(createRemainingQuery, remainingValues);
          console.log(`✅ Creata transazione per rimanenza: ${remainingResult.rows[0].id}, importo: ${signedRemainingAmount}`);
          
          // Aggiungiamo la transazione di rimanenza all'array delle transazioni create
          transactions.push(remainingResult.rows[0].id);
          
        } else {
          // CASO 3: L'importo totale è superiore all'importo del record originale
          console.log('📋 CASO 3: L\'importo totale è superiore all\'importo del record originale');
          
          // Calcola l'eccedenza
          const excessAmount = parseFloat((totalAmount - parentAmount).toFixed(2));
          console.log(`📊 Eccedenza: ${excessAmount}`);
          
          // Crea una nuova transazione per l'eccedenza
          const createExcessQuery = `
            INSERT INTO transactions (
              date, description, amount, db, 
              ownerid, categoryid, subjectid, detailid, 
              note, paymenttype, status, import_batch_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id
          `;
          
          const excessDescription = 'Da precedente rimanenza su carta';
          
          // Applichiamo il segno corretto all'eccedenza in base al segno della transazione originale
          const signedExcessAmount = parentSign * excessAmount;
          
          const excessValues = [
            parentTransaction.date,
            excessDescription,
            signedExcessAmount,
            db,
            parentTransaction.ownerid,
            parentTransaction.categoryid,
            parentTransaction.subjectid,
            parentTransaction.detailid || null,
            `Eccedenza rispetto alla transazione ${parentTransaction.id}`,
            parentTransaction.paymenttype,
            'pending',
            batchId
          ];
          
          const excessResult = await client.query(createExcessQuery, excessValues);
          console.log(`✅ Creata transazione per eccedenza: ${excessResult.rows[0].id}, importo: ${signedExcessAmount}`);
          
          // Aggiungiamo la transazione di eccedenza all'array delle transazioni create
          transactions.push(excessResult.rows[0].id);
        }
        
        await client.query('COMMIT');
        
        console.log('✅ Importazione associativa completata con successo! Commissioni create:', transactions.length);
        
        reply.send({ 
          success: true, 
          message: `Import associated transactions completed successfully. ${transactions.length} transactions created.`,
          batchId,
          transactionCount: transactions.length,
          amountComparison: {
            parentAmount,
            totalAmount,
            difference,
            percentageDifference,
            isWithinThreshold: percentageDifference <= 5,
            resultCase: Math.abs(difference) < 0.01 ? 1 : (totalAmount < parentAmount ? 2 : 3),
            resultDescription: Math.abs(difference) < 0.01 
              ? "Importi corrispondenti, record originale azzerato" 
              : (totalAmount < parentAmount 
                ? "Importo inferiore, record originale azzerato e creata transazione per la rimanenza" 
                : "Importo superiore, record originale azzerato e creata transazione per l'eccedenza"),
            commissionsIncluded: commissions ? parseFloat(commissions) : 0
          }
        });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Errore durante l\'importazione associativa, rollback effettuato:', err);
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('❌ Errore generale durante l\'importazione associativa:', error);
      reply.status(500).send({ 
        error: 'Failed to import associated data', 
        message: error.message 
      });
    }
  });
};

export default transactionImportAssociated;
