  // Modifica della funzione di importazione per tenere traccia dei batch
  // Questa funzione andrà a sostituire o integrare la funzione esistente
  
  fastify.post('/import', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      console.log('📂 Inizio importazione batch...');
      
      const file = await request.file();
      const bufferedFile = await file.toBuffer();
      console.log('✅ File ricevuto!');

      const { db, owner, category, subject, details } = JSON.parse(file.fields.metadata.value);
      console.log('📊 Metadata ricevuti:', { db, owner, category, subject, details });

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
          file.filename, 
          file.file.bytesRead
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
