// Aggiungiamo queste nuove rotte alla fine del file transaction.js

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
          COUNT(t.id) as transaction_count
        FROM 
          import_batches i
        LEFT JOIN 
          transactions t ON t.import_batch_id = i.id
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
  
  // Questo dovrebbe essere alla fine del file, dopo aver aggiunto tutte le route
}

export default transaction;
