const mlAnalysis = async (fastify) => {
  
  fastify.get('/stats', async (request, reply) => {
    const client = await fastify.pg.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          db,
          COUNT(*) as total_transactions,
          COUNT(CASE WHEN categoryid IS NOT NULL AND subjectid IS NOT NULL THEN 1 END) as classified_transactions
        FROM transactions 
        GROUP BY db
        ORDER BY db
      `);
      
      reply.send({
        success: true,
        data: result.rows
      });
      
    } catch (error) {
      reply.status(500).send({
        success: false,
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
  fastify.get('/test', async (request, reply) => {
    reply.send({
      success: true,
      message: 'ML Analysis routes attive!'
    });
  });
  
  fastify.get('/check-users', async (request, reply) => {
    const client = await fastify.pg.connect();
    
    try {
      // Controlla se la tabella users esiste
      const tablesResult = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      `);
      
      if (tablesResult.rows.length === 0) {
        return reply.send({
          success: false,
          message: 'Tabella users non esiste'
        });
      }
      
      // Controlla gli utenti nella tabella
      const usersResult = await client.query('SELECT email, firstName, lastName FROM users');
      
      reply.send({
        success: true,
        message: 'Tabella users esiste',
        users: usersResult.rows
      });
      
    } catch (error) {
      reply.status(500).send({
        success: false,
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
};

export default mlAnalysis;
