// routes/scadenziario.js
export default async function scadenziarioRoutes(fastify, options) {
  // Middleware di autenticazione
  const preHandler = fastify.authenticate;

  // Endpoint per ottenere tutte le scadenze
  fastify.post('/list', { preHandler }, async (request, reply) => {
    try {
      const { db, filters = {} } = request.body;

      // Costruzione della query di base
      let queryText = `
        SELECT 
          s.id,
          s.subject,
          s.description,
          s.causale,
          to_char(s.date, 'YYYY-MM-DD') AS date,
          s.amount,
          to_char(s.payment_date, 'YYYY-MM-DD') AS payment_date,
          s.status,
          o.name as owner_name,
          o.id as owner_id
        FROM 
          scadenziario s
        LEFT JOIN
          owners o ON s.owner_id = o.id
        WHERE 
          1=1
      `;
      
      // Array per i parametri della query
      const queryParams = [];
      
      // Aggiunta filtri alla query
      if (filters.subject) {
        queryParams.push(`%${filters.subject}%`);
        queryText += ` AND s.subject ILIKE $${queryParams.length}`;
      }
      
      if (filters.description) {
        queryParams.push(`%${filters.description}%`);
        queryText += ` AND s.description ILIKE $${queryParams.length}`;
      }
      
      if (filters.status && filters.status.length) {
        const statusPlaceholders = filters.status.map((_, index) => `$${queryParams.length + index + 1}`).join(', ');
        queryText += ` AND s.status IN (${statusPlaceholders})`;
        queryParams.push(...filters.status);
      }
      
      if (filters.startDate && filters.endDate) {
        queryParams.push(filters.startDate, filters.endDate);
        queryText += ` AND s.date BETWEEN $${queryParams.length - 1} AND $${queryParams.length}`;
      }
      
      // Filtro per proprietario specifico
      if (filters.ownerId) {
        queryParams.push(filters.ownerId);
        queryText += ` AND s.owner_id = $${queryParams.length}`;
      }

      // Ordinamento e limite
      queryText += ` ORDER BY s.date ASC`;
      
      // Esecuzione query
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, queryParams);
        reply.send({ data: result.rows });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante il recupero dei dati dello scadenziario:', error);
      reply.status(500).send({ 
        error: 'Errore durante il recupero dei dati dello scadenziario', 
        message: error.message 
      });
    }
  });

  // Endpoint per ottenere una scadenza specifica
  fastify.post('/details', { preHandler }, async (request, reply) => {
    try {
      const { db, id } = request.body;
      
      if (!id) {
        return reply.status(400).send({ error: 'ID non specificato' });
      }

      const queryText = `
        SELECT 
          s.id,
          s.subject,
          s.description,
          s.causale,
          to_char(s.date, 'YYYY-MM-DD') AS date,
          s.amount,
          to_char(s.payment_date, 'YYYY-MM-DD') AS payment_date,
          s.status,
          o.name as owner_name,
          o.id as owner_id
        FROM 
          scadenziario s
        LEFT JOIN
          owners o ON s.owner_id = o.id
        WHERE 
          s.id = $1
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, [id]);
        
        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Scadenza non trovata' });
        }
        
        reply.send({ data: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante il recupero dei dettagli della scadenza:', error);
      reply.status(500).send({ 
        error: 'Errore durante il recupero dei dettagli della scadenza', 
        message: error.message 
      });
    }
  });

  // Endpoint per creare una nuova scadenza
  fastify.post('/create', { preHandler }, async (request, reply) => {
    try {
      const { db, scadenza } = request.body;
      
      if (!scadenza) {
        return reply.status(400).send({ error: 'Dati della scadenza non specificati' });
      }

      const { 
        subject, 
        description, 
        causale, 
        date, 
        amount, 
        payment_date, 
        status, 
        owner_id 
      } = scadenza;
      
      // Verifica dei campi obbligatori
      if (!subject || !date || amount === undefined || !status) {
        return reply.status(400).send({ 
          error: 'Campi obbligatori mancanti', 
          message: 'I campi soggetto, data, importo e stato sono obbligatori' 
        });
      }

      const queryText = `
        INSERT INTO scadenziario 
          (subject, description, causale, date, amount, payment_date, status, owner_id)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING 
          id, 
          subject, 
          description, 
          causale, 
          to_char(date, 'YYYY-MM-DD') AS date,
          amount,
          to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
          status
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, [
          subject, 
          description || null, 
          causale || null, 
          date, 
          amount, 
          payment_date || null, 
          status, 
          owner_id || null
        ]);
        
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante la creazione della scadenza:', error);
      reply.status(500).send({ 
        error: 'Errore durante la creazione della scadenza', 
        message: error.message 
      });
    }
  });

  // Endpoint per aggiornare una scadenza esistente
  fastify.post('/update', { preHandler }, async (request, reply) => {
    try {
      const { db, id, scadenza } = request.body;
      
      if (!id || !scadenza) {
        return reply.status(400).send({ error: 'ID o dati della scadenza non specificati' });
      }

      const { 
        subject, 
        description, 
        causale, 
        date, 
        amount, 
        payment_date, 
        status, 
        owner_id 
      } = scadenza;
      
      // Costruzione della query di aggiornamento
      let updateFields = [];
      const queryParams = [id]; // Primo parametro è sempre l'ID
      let paramIndex = 2; // Inizia da 2 perché l'ID è $1
      
      if (subject !== undefined) {
        updateFields.push(`subject = $${paramIndex++}`);
        queryParams.push(subject);
      }
      
      if (description !== undefined) {
        updateFields.push(`description = $${paramIndex++}`);
        queryParams.push(description);
      }
      
      if (causale !== undefined) {
        updateFields.push(`causale = $${paramIndex++}`);
        queryParams.push(causale);
      }
      
      if (date !== undefined) {
        updateFields.push(`date = $${paramIndex++}`);
        queryParams.push(date);
      }
      
      if (amount !== undefined) {
        updateFields.push(`amount = $${paramIndex++}`);
        queryParams.push(amount);
      }
      
      if (payment_date !== undefined) {
        updateFields.push(`payment_date = $${paramIndex++}`);
        queryParams.push(payment_date);
      }
      
      if (status !== undefined) {
        updateFields.push(`status = $${paramIndex++}`);
        queryParams.push(status);
      }
      
      if (owner_id !== undefined) {
        updateFields.push(`owner_id = $${paramIndex++}`);
        queryParams.push(owner_id);
      }
      
      if (updateFields.length === 0) {
        return reply.status(400).send({ error: 'Nessun campo da aggiornare' });
      }
      
      const queryText = `
        UPDATE scadenziario
        SET ${updateFields.join(', ')}
        WHERE id = $1
        RETURNING 
          id, 
          subject, 
          description, 
          causale, 
          to_char(date, 'YYYY-MM-DD') AS date,
          amount,
          to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
          status
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, queryParams);
        
        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Scadenza non trovata' });
        }
        
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento della scadenza:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'aggiornamento della scadenza', 
        message: error.message 
      });
    }
  });

  // Endpoint per aggiornare solo lo stato del pagamento
  fastify.post('/update-payment', { preHandler }, async (request, reply) => {
    try {
      const { db, id, payment_date, status } = request.body;
      
      if (!id) {
        return reply.status(400).send({ error: 'ID non specificato' });
      }

      // Se lo stato è 'completed', impostiamo la data di pagamento se non fornita
      let paymentDate = payment_date;
      let paymentStatus = status || 'completed';
      
      if (paymentStatus === 'completed' && !paymentDate) {
        paymentDate = new Date().toISOString().substring(0, 10); // formato YYYY-MM-DD
      }

      // Se la data di pagamento è null, lo stato non può essere 'completed'
      if (!paymentDate && paymentStatus === 'completed') {
        paymentStatus = 'upcoming'; // default allo stato "in scadenza" se senza data
      }
      
      const queryText = `
        UPDATE scadenziario
        SET payment_date = $2, status = $3
        WHERE id = $1
        RETURNING 
          id, 
          subject, 
          description, 
          causale, 
          to_char(date, 'YYYY-MM-DD') AS date,
          amount,
          to_char(payment_date, 'YYYY-MM-DD') AS payment_date,
          status
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, [id, paymentDate, paymentStatus]);
        
        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Scadenza non trovata' });
        }
        
        reply.send({ data: result.rows[0], success: true });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento dello stato di pagamento:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'aggiornamento dello stato di pagamento', 
        message: error.message 
      });
    }
  });

  // Endpoint per eliminare una scadenza
  fastify.post('/delete', { preHandler }, async (request, reply) => {
    try {
      const { db, id } = request.body;
      
      if (!id) {
        return reply.status(400).send({ error: 'ID non specificato' });
      }

      const queryText = `
        DELETE FROM scadenziario
        WHERE id = $1
        RETURNING id
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, [id]);
        
        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Scadenza non trovata' });
        }
        
        reply.send({ success: true, message: 'Scadenza eliminata con successo' });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'eliminazione della scadenza:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'eliminazione della scadenza', 
        message: error.message 
      });
    }
  });

  // Endpoint per eliminare più scadenze
  fastify.post('/delete-multiple', { preHandler }, async (request, reply) => {
    try {
      const { db, ids } = request.body;
      
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return reply.status(400).send({ error: 'Nessun ID specificato' });
      }

      // Costruzione dei parametri per la query
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
      const queryText = `
        DELETE FROM scadenziario
        WHERE id IN (${placeholders})
        RETURNING id
      `;
      
      const client = await fastify.pg.pool.connect();
      try {
        const result = await client.query(queryText, ids);
        
        reply.send({ 
          success: true, 
          message: `Eliminate ${result.rows.length} scadenze su ${ids.length} richieste` 
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'eliminazione multipla delle scadenze:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'eliminazione multipla delle scadenze', 
        message: error.message 
      });
    }
  });

  // Endpoint per aggiornare automaticamente lo stato delle scadenze
  fastify.post('/update-status', { preHandler }, async (request, reply) => {
    try {
      const { db } = request.body;
      const today = new Date();
      const todayStr = today.toISOString().substring(0, 10); // YYYY-MM-DD
      
      // Data di 15 giorni nel futuro (per scadenze imminenti)
      const futureDate = new Date();
      futureDate.setDate(today.getDate() + 15);
      const futureDateStr = futureDate.toISOString().substring(0, 10);

      const client = await fastify.pg.pool.connect();
      try {
        // Aggiorna le scadenze scadute (senza data pagamento e data < oggi)
        await client.query(`
          UPDATE scadenziario
          SET status = 'overdue'
          WHERE payment_date IS NULL
          AND date < $1
        `, [todayStr]);
        
        // Aggiorna le scadenze imminenti (senza data pagamento, data >= oggi e <= oggi + 15 giorni)
        await client.query(`
          UPDATE scadenziario
          SET status = 'upcoming'
          WHERE payment_date IS NULL
          AND date >= $1
          AND date <= $2
        `, [todayStr, futureDateStr]);
        
        // Aggiorna le scadenze future (senza data pagamento, data > oggi + 15 giorni)
        await client.query(`
          UPDATE scadenziario
          SET status = 'future'
          WHERE payment_date IS NULL
          AND date > $1
        `, [futureDateStr]);
        
        // Tutte le scadenze con data di pagamento sono 'completed'
        await client.query(`
          UPDATE scadenziario
          SET status = 'completed'
          WHERE payment_date IS NOT NULL
        `);
        
        reply.send({ 
          success: true, 
          message: 'Stato delle scadenze aggiornato con successo' 
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Errore durante l\'aggiornamento automatico degli stati:', error);
      reply.status(500).send({ 
        error: 'Errore durante l\'aggiornamento automatico degli stati', 
        message: error.message 
      });
    }
  });
};
