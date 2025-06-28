// Route per la gestione dei database
const databases = async (fastify) => {
  
  // Ottieni tutti i database attivi per la select del login
  fastify.get('/list', async (request, reply) => {
    try {
      const query = `
        SELECT db_key, db_name, description 
        FROM databases 
        WHERE is_active = true 
        ORDER BY db_name
      `;
      
      const { rows } = await fastify.pg.query(query);
      
      reply.send({
        success: true,
        databases: rows.map(row => ({
          value: row.db_key,
          label: row.db_name,
          description: row.description
        }))
      });
    } catch (error) {
      console.error('Errore nel recupero dei database:', error);
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nel recupero dei database' 
      });
    }
  });

  // Ottieni tutti i database (per admin panel) - richiede autenticazione
  fastify.get('/all', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const query = `
        SELECT id, db_key, db_name, description, is_active, created_at, updated_at 
        FROM databases 
        ORDER BY db_name
      `;
      
      const { rows } = await fastify.pg.query(query);
      
      reply.send({
        success: true,
        databases: rows
      });
    } catch (error) {
      console.error('Errore nel recupero di tutti i database:', error);
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nel recupero dei database' 
      });
    }
  });

  // Crea un nuovo database - richiede autenticazione e ruolo admin
  fastify.post('/create', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { db_key, db_name, description } = request.body;
      
      if (!db_key || !db_name) {
        return reply.code(400).send({
          success: false,
          message: 'db_key e db_name sono obbligatori'
        });
      }

      const query = `
        INSERT INTO databases (db_key, db_name, description)
        VALUES ($1, $2, $3)
        RETURNING id, db_key, db_name, description, is_active, created_at
      `;
      
      const { rows } = await fastify.pg.query(query, [db_key, db_name, description]);
      
      reply.send({
        success: true,
        message: 'Database creato con successo',
        database: rows[0]
      });
    } catch (error) {
      console.error('Errore nella creazione del database:', error);
      
      if (error.code === '23505') { // Unique violation
        return reply.code(400).send({
          success: false,
          message: 'Un database con questa chiave esiste già'
        });
      }
      
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nella creazione del database' 
      });
    }
  });

  // Aggiorna un database - richiede autenticazione e ruolo admin
  fastify.put('/update/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { db_key, db_name, description, is_active } = request.body;
      
      const query = `
        UPDATE databases 
        SET db_key = COALESCE($1, db_key),
            db_name = COALESCE($2, db_name),
            description = COALESCE($3, description),
            is_active = COALESCE($4, is_active),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
        RETURNING id, db_key, db_name, description, is_active, updated_at
      `;
      
      const { rows } = await fastify.pg.query(query, [db_key, db_name, description, is_active, id]);
      
      if (rows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Database non trovato'
        });
      }
      
      reply.send({
        success: true,
        message: 'Database aggiornato con successo',
        database: rows[0]
      });
    } catch (error) {
      console.error('Errore nell\'aggiornamento del database:', error);
      
      if (error.code === '23505') { // Unique violation
        return reply.code(400).send({
          success: false,
          message: 'Un database con questa chiave esiste già'
        });
      }
      
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nell\'aggiornamento del database' 
      });
    }
  });

  // Elimina (disattiva) un database - richiede autenticazione e ruolo admin
  fastify.delete('/delete/:id', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { id } = request.params;
      
      // Invece di eliminare, disattiviamo il database per mantenere l'integrità referenziale
      const query = `
        UPDATE databases 
        SET is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, db_key, db_name
      `;
      
      const { rows } = await fastify.pg.query(query, [id]);
      
      if (rows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Database non trovato'
        });
      }
      
      reply.send({
        success: true,
        message: 'Database disattivato con successo',
        database: rows[0]
      });
    } catch (error) {
      console.error('Errore nella disattivazione del database:', error);
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nella disattivazione del database' 
      });
    }
  });
};

export default databases;
