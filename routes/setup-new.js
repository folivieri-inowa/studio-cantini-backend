import { v4 as uuidv4 } from 'uuid';

const setup = async (fastify, options) => {
  
  /**
   * Crea il soggetto "Da classificare" per entrambi i database
   * POST /v1/setup/create-da-classificare
   */
  fastify.post('/create-da-classificare', async (request, reply) => {
    const client = await fastify.pg.connect();
    
    try {
      console.log('🔧 Creazione soggetto "Da classificare"...');
      
      // Prima verifichiamo se esiste già la categoria "Generale"
      const checkGenerale = await client.query(
        'SELECT id FROM categories WHERE name = $1 LIMIT 1',
        ['Generale']
      );
      
      let generaleId;
      if (checkGenerale.rows.length === 0) {
        // Creiamo la categoria "Generale" se non esiste
        generaleId = uuidv4();
        await client.query(
          'INSERT INTO categories (id, name, db) VALUES ($1, $2, $3)',
          [generaleId, 'Generale', 'db1']
        );
        await client.query(
          'INSERT INTO categories (id, name, db) VALUES ($1, $2, $3)',
          [uuidv4(), 'Generale', 'db2']
        );
        console.log('✅ Categoria "Generale" creata per entrambi i database');
      } else {
        generaleId = checkGenerale.rows[0].id;
        console.log('✅ Categoria "Generale" già esistente');
      }
      
      reply.send({
        success: true,
        message: 'Setup completato',
        generaleId: generaleId
      });
      
    } catch (error) {
      console.error('❌ Errore durante il setup:', error);
      reply.status(500).send({
        success: false,
        message: 'Errore durante il setup',
        error: error.message
      });
    } finally {
      client.release();
    }
  });

  /**
   * Ottiene statistiche sulle transazioni classificate
   * GET /v1/setup/stats
   */
  fastify.get('/stats', { preHandler: fastify.authenticate }, async (request, reply) => {
    const client = await fastify.pg.connect();
    
    try {
      // Statistiche generali delle transazioni
      const statsQuery = `
        SELECT 
          db,
          COUNT(*) as total_transactions,
          COUNT(CASE WHEN categoryid IS NOT NULL AND subjectid IS NOT NULL THEN 1 END) as classified_transactions,
          COUNT(CASE WHEN categoryid IS NOT NULL AND subjectid IS NOT NULL AND detailid IS NOT NULL THEN 1 END) as fully_classified
        FROM transactions 
        GROUP BY db
        ORDER BY db
      `;
      
      const statsResult = await client.query(statsQuery);
      
      // Categorie più utilizzate
      const categoriesQuery = `
        SELECT 
          c.name as category_name,
          COUNT(t.id) as transaction_count,
          t.db
        FROM transactions t
        JOIN categories c ON t.categoryid = c.id
        WHERE t.categoryid IS NOT NULL
        GROUP BY c.name, t.db
        ORDER BY t.db, transaction_count DESC
        LIMIT 10
      `;
      
      const categoriesResult = await client.query(categoriesQuery);
      
      reply.send({
        success: true,
        statistics: statsResult.rows,
        topCategories: categoriesResult.rows
      });
      
    } catch (error) {
      console.error('❌ Errore durante il recupero delle statistiche:', error);
      reply.status(500).send({
        success: false,
        message: 'Errore durante il recupero delle statistiche',
        error: error.message
      });
    } finally {
      client.release();
    }
  });
}

export default setup;
