import { v4 as uuidv4 } from 'uuid';

async function SetupRoutes(fastify, options) {
  
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
      
      // Ora verifichiamo se esiste già il soggetto "Da classificare"
      const existingSubjects = await client.query(
        'SELECT id, db FROM subjects WHERE name = $1 AND category_id IN (SELECT id FROM categories WHERE name = $2)',
        ['Da classificare', 'Generale']
      );
      
      const results = {
        db1: null,
        db2: null,
        created: [],
        existed: []
      };
      
      // Controlla per db1
      const db1Subject = existingSubjects.rows.find(s => s.db === 'db1');
      if (!db1Subject) {
        const db1GeneraleId = await client.query(
          'SELECT id FROM categories WHERE name = $1 AND db = $2',
          ['Generale', 'db1']
        );
        
        const newSubjectId = uuidv4();
        await client.query(
          'INSERT INTO subjects (id, name, category_id, db) VALUES ($1, $2, $3, $4)',
          [newSubjectId, 'Da classificare', db1GeneraleId.rows[0].id, 'db1']
        );
        results.db1 = newSubjectId;
        results.created.push('db1');
        console.log('✅ Soggetto "Da classificare" creato per db1');
      } else {
        results.db1 = db1Subject.id;
        results.existed.push('db1');
        console.log('✅ Soggetto "Da classificare" già esistente per db1');
      }
      
      // Controlla per db2
      const db2Subject = existingSubjects.rows.find(s => s.db === 'db2');
      if (!db2Subject) {
        const db2GeneraleId = await client.query(
          'SELECT id FROM categories WHERE name = $1 AND db = $2',
          ['Generale', 'db2']
        );
        
        const newSubjectId = uuidv4();
        await client.query(
          'INSERT INTO subjects (id, name, category_id, db) VALUES ($1, $2, $3, $4)',
          [newSubjectId, 'Da classificare', db2GeneraleId.rows[0].id, 'db2']
        );
        results.db2 = newSubjectId;
        results.created.push('db2');
        console.log('✅ Soggetto "Da classificare" creato per db2');
      } else {
        results.db2 = db2Subject.id;
        results.existed.push('db2');
        console.log('✅ Soggetto "Da classificare" già esistente per db2');
      }
      
      // Verifica finale
      const verification = await client.query(`
        SELECT 
          s.id,
          s.name as subject_name,
          s.db,
          c.name as category_name
        FROM subjects s
        JOIN categories c ON s.category_id = c.id
        WHERE s.name = 'Da classificare' 
          AND c.name = 'Generale'
        ORDER BY s.db
      `);
      
      reply.send({
        success: true,
        message: 'Setup completato con successo',
        results: {
          ...results,
          verification: verification.rows
        }
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
   * Analizza transazioni non classificate e le sposta su "Da classificare"
   * POST /v1/setup/move-unclassifiable
   */
  fastify.post('/move-unclassifiable', async (request, reply) => {
    const client = await fastify.pg.connect();
    
    try {
      console.log('🔄 Analisi e spostamento transazioni non classificabili...');
      
      // Pattern di transazioni difficili da classificare automaticamente
      const unclassifiablePatterns = [
        'Pagamento CBILL%',
        'Delega Unica - F24%',
        'Prelev. Cont.%',
        'Bancomat - PRELIEVO%'
      ];
      
      // Trova il soggetto "Da classificare" per entrambi i db
      const daClassificare = await client.query(`
        SELECT 
          s.id,
          s.db,
          c.id as category_id
        FROM subjects s
        JOIN categories c ON s.category_id = c.id
        WHERE s.name = 'Da classificare' AND c.name = 'Generale'
      `);
      
      if (daClassificare.rows.length === 0) {
        return reply.status(400).send({
          success: false,
          message: 'Soggetto "Da classificare" non trovato. Esegui prima /create-da-classificare'
        });
      }
      
      const results = {
        db1: { moved: 0, categoryId: null, subjectId: null },
        db2: { moved: 0, categoryId: null, subjectId: null }
      };
      
      for (const dbInfo of daClassificare.rows) {
        results[dbInfo.db].categoryId = dbInfo.category_id;
        results[dbInfo.db].subjectId = dbInfo.id;
        
        // Costruisci la query WHERE per i pattern
        const whereConditions = unclassifiablePatterns.map(() => 'description LIKE ?').join(' OR ');
        const query = `
          UPDATE transactions 
          SET 
            categoryid = $1,
            subjectid = $2,
            detailid = NULL
          WHERE db = $3 
            AND (${whereConditions.replace(/\?/g, (match, offset) => `$${offset + 4}`)})
            AND (categoryid IS NULL OR subjectid IS NULL OR categoryid != $1 OR subjectid != $2)
        `;
        
        const params = [
          dbInfo.category_id,
          dbInfo.id,
          dbInfo.db,
          ...unclassifiablePatterns
        ];
        
        const updateResult = await client.query(query, params);
        results[dbInfo.db].moved = updateResult.rowCount;
        
        console.log(`✅ ${dbInfo.db}: ${updateResult.rowCount} transazioni spostate su "Da classificare"`);
      }
      
      reply.send({
        success: true,
        message: 'Transazioni non classificabili spostate con successo',
        results
      });
      
    } catch (error) {
      console.error('❌ Errore durante lo spostamento:', error);
      reply.status(500).send({
        success: false,
        message: 'Errore durante lo spostamento',
        error: error.message
      });
    } finally {
      client.release();
    }
  });

  /**
   * Statistiche di classificazione
   * GET /v1/setup/classification-stats
   */
  fastify.get('/classification-stats', async (request, reply) => {
    const client = await fastify.pg.connect();
    
    try {
      const stats = await client.query(`
        SELECT 
          db,
          COUNT(*) as total_transactions,
          COUNT(CASE WHEN categoryid IS NOT NULL AND subjectid IS NOT NULL THEN 1 END) as classified_transactions,
          COUNT(CASE WHEN categoryid IS NOT NULL AND subjectid IS NOT NULL AND detailid IS NOT NULL THEN 1 END) as fully_classified_transactions,
          COUNT(CASE 
            WHEN s.name = 'Da classificare' AND c.name = 'Generale' THEN 1 
          END) as da_classificare_transactions
        FROM transactions t
        LEFT JOIN subjects s ON t.subjectid = s.id
        LEFT JOIN categories c ON t.categoryid = c.id
        GROUP BY db
        ORDER BY db
      `);
      
      reply.send({
        success: true,
        statistics: stats.rows
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

export default SetupRoutes;
