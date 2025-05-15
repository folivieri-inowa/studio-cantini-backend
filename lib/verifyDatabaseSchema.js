/**
 * verifyDatabaseSchema.js
 * Questo script verifica specifiche strutture del database e le corregge se necessario.
 * Viene eseguito all'avvio del server dopo le migrazioni standard.
 */

/**
 * Verifica che la colonna is_credit_card esista nella tabella owners
 * @param {Object} fastify - Istanza di Fastify
 */
async function verifyIsCreditCardColumn(fastify) {
  try {
    console.log('Verifica della colonna is_credit_card nella tabella owners...');
    
    // Verifica se la colonna esiste
    const checkResult = await fastify.pg.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'owners' AND column_name = 'is_credit_card';
    `);
    
    if (checkResult.rows.length === 0) {
      console.log('La colonna is_credit_card non esiste nella tabella owners. La aggiungo...');
      
      // Crea la colonna
      await fastify.pg.query(`
        ALTER TABLE owners ADD COLUMN is_credit_card BOOLEAN DEFAULT FALSE;
        COMMENT ON COLUMN owners.is_credit_card IS 'Indica se il record è riferito ad una carta di credito (TRUE) o no (FALSE)';
      `);
      
      console.log('Colonna is_credit_card aggiunta con successo!');
    } else {
      console.log('La colonna is_credit_card esiste già nella tabella owners.');
    }
  } catch (error) {
    console.error('Errore durante la verifica/aggiunta della colonna is_credit_card:', error);
    throw error;
  }
}

/**
 * Verifica lo schema del database e corregge eventuali problemi
 * @param {Object} fastify - Istanza di Fastify
 */
export default async function verifyDatabaseSchema(fastify) {
  try {
    console.log('Verifica dello schema del database...');
    
    // Verifica la colonna is_credit_card
    await verifyIsCreditCardColumn(fastify);
    
    // Qui puoi aggiungere altre verifiche dello schema se necessario
    
    console.log('Verifica dello schema del database completata con successo!');
  } catch (error) {
    console.error('Errore durante la verifica dello schema del database:', error);
    throw error;
  }
}
