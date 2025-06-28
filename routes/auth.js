// Fastify
import fastifyJwt from "@fastify/jwt";
// Utils
import bcrypt from "bcrypt";
import { checkUserLogin } from '../lib/utils.js';

const auth = async (fastify) => {
  // Registrazione del plugin fastify-jwt
  fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET,
  })

  // Middleware per la verifica del token
  fastify.get('/me', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const user = await checkUserLogin(fastify, request.headers.authorization);

      reply.send({ user });
    } catch (error) {
      console.error(error);
      reply.send({ message: 'Invalid token' });
    }
  });

  // Login di un utente
  fastify.post('/login', async (request, reply) => {
    const { email, password, db } = request.body;

    const query = 'SELECT * FROM users WHERE email = $1';
    try {
      const { rows } = await fastify.pg.query(query, [email]);

      if (rows.length === 0) {
        return reply.send({ success: false, message: 'Utente non trovato' });
      }

      const user = rows[0];
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        return reply.code(400).send({ message: 'Credenziali non valide', status: 400 });
      }

      const dbRoles = user.dbrole
      const userRole = dbRoles.find(role => role.db === db);

      if (!userRole) {
        return reply.code(400).send({ message: 'Database non trovato', status: 400 });
      }

      delete user.password;
      delete user.dbrole;

      const token = fastify.jwt.sign({ id: user.id }, {
        expiresIn: 14400 // 4 ore in secondi
      });

      reply.send({ accessToken: token, user: {...user, role: userRole.role, db:db} });
    } catch (error) {
      console.error(error);
      reply.code(500).send({ message: 'Errore durante il login', status: 500 });
    }
  });

  // Registrazione di un nuovo utente
  fastify.post('/register', async (request, reply) => {
    const { email, password, firstName, lastName } = request.body;

    // Hash the password
    const hashedPassword = bcrypt.hashSync(password, 10);

    // Insert the new user into the PostgreSQL database
    const query = `
        INSERT INTO users (email, password, firstName, lastName)
        VALUES ($1, $2, $3, $4)
        RETURNING id, email, firstName, lastName;
    `;
    const values = [email, hashedPassword, firstName, lastName];

    try {
      const { rows } = await fastify.pg.query(query, values);
      const user = rows[0];

      // Generate a JWT token
      const token = fastify.jwt.sign({ userId: user.id }, {
        expiresIn: 14400 // 4 hours in seconds
      });

      reply.send({ message: 'User created successfully', accessToken: token, user });
    } catch (error) {
      console.error(error);
      reply.code(400).send({ message: 'Error creating user', status: 400 });
    }
  })


  // Aggiorna un utente esistente (richiede autenticazione)
  fastify.put('/update', { preHandler: fastify.authenticate }, async (request, reply) => {
    const token = request.headers.authorization.split(' ')[1]; // recuperare il token dalla richiesta
    const decoded = await fastify.jwt.verify(token); // decodificare il token
    const userId = decoded.userId; // recuperare l'id del cliente dal payload del token

    // Cerca l'utente nel database
    const querySelect = 'SELECT * FROM users WHERE id = $1';
    const { rows } = await fastify.pg.query(querySelect, [userId]);
    const user = rows[0];

    if (!user) {
      return reply.send({ message: 'Utente non trovato' });
    }

    // Aggiorna l'utente
    let updateFields = [];
    let updateValues = [];
    let index = 1;

    for (const [key, value] of Object.entries(request.body)) {
      if (key === 'password') {
        updateFields.push(`${key} = $${index}`);
        updateValues.push(bcrypt.hashSync(value, 10));
      } else {
        updateFields.push(`${key} = $${index}`);
        updateValues.push(value);
      }
      index++;
    }

    const queryUpdate = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${index}`;
    updateValues.push(userId);

    await fastify.pg.query(queryUpdate, updateValues);

    // Recupera l'utente aggiornato
    const { rows: updatedRows } = await fastify.pg.query(querySelect, [userId]);
    const updatedUser = updatedRows[0];

    // Invia l'utente aggiornato
    reply.send({ user: updatedUser });
  });

  // Ottieni i ruoli di un utente per tutti i database - richiede autenticazione
  fastify.get('/user-roles/:userId', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { userId } = request.params;
      
      const query = `
        SELECT u.id, u.email, u.firstName, u.lastName, u.dbrole,
               json_agg(
                 json_build_object(
                   'db_key', d.db_key,
                   'db_name', d.db_name,
                   'role', (
                     SELECT (role_data->>'role')::text
                     FROM jsonb_array_elements(u.dbrole) AS role_data
                     WHERE role_data->>'db' = d.db_key
                   )
                 )
               ) as user_roles
        FROM users u
        CROSS JOIN databases d
        WHERE u.id = $1 AND d.is_active = true
        GROUP BY u.id, u.email, u.firstName, u.lastName, u.dbrole
      `;
      
      const { rows } = await fastify.pg.query(query, [userId]);
      
      if (rows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Utente non trovato'
        });
      }
      
      const user = rows[0];
      reply.send({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          roles: user.user_roles.filter(role => role.role !== null)
        }
      });
    } catch (error) {
      console.error('Errore nel recupero dei ruoli utente:', error);
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nel recupero dei ruoli utente' 
      });
    }
  });

  // Aggiorna i ruoli di un utente - richiede autenticazione e ruolo admin
  fastify.put('/user-roles/:userId', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { userId } = request.params;
      const { roles } = request.body; // Array di {db_key, role}
      
      if (!Array.isArray(roles)) {
        return reply.code(400).send({
          success: false,
          message: 'Il campo roles deve essere un array'
        });
      }

      // Verifica che tutti i database esistano
      const dbKeys = roles.map(r => r.db_key);
      const dbQuery = 'SELECT db_key FROM databases WHERE db_key = ANY($1) AND is_active = true';
      const { rows: dbRows } = await fastify.pg.query(dbQuery, [dbKeys]);
      
      if (dbRows.length !== dbKeys.length) {
        const existingKeys = dbRows.map(r => r.db_key);
        const missingKeys = dbKeys.filter(key => !existingKeys.includes(key));
        return reply.code(400).send({
          success: false,
          message: `Database non trovati: ${missingKeys.join(', ')}`
        });
      }

      // Converte i ruoli nel formato JSON atteso
      const dbroleJson = roles.map(role => ({
        db: role.db_key,
        role: role.role
      }));

      const updateQuery = `
        UPDATE users 
        SET dbrole = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, email, firstName, lastName, dbrole
      `;
      
      const { rows } = await fastify.pg.query(updateQuery, [JSON.stringify(dbroleJson), userId]);
      
      if (rows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Utente non trovato'
        });
      }
      
      reply.send({
        success: true,
        message: 'Ruoli utente aggiornati con successo',
        user: rows[0]
      });
    } catch (error) {
      console.error('Errore nell\'aggiornamento dei ruoli utente:', error);
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nell\'aggiornamento dei ruoli utente' 
      });
    }
  });

  // Aggiungi un ruolo a un utente per un database specifico - richiede autenticazione e ruolo admin
  fastify.post('/user-roles/:userId/add', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { userId } = request.params;
      const { db_key, role } = request.body;
      
      if (!db_key || !role) {
        return reply.code(400).send({
          success: false,
          message: 'db_key e role sono obbligatori'
        });
      }

      // Verifica che il database esista
      const dbQuery = 'SELECT db_key FROM databases WHERE db_key = $1 AND is_active = true';
      const { rows: dbRows } = await fastify.pg.query(dbQuery, [db_key]);
      
      if (dbRows.length === 0) {
        return reply.code(400).send({
          success: false,
          message: 'Database non trovato o non attivo'
        });
      }

      // Ottieni i ruoli attuali dell'utente
      const userQuery = 'SELECT dbrole FROM users WHERE id = $1';
      const { rows: userRows } = await fastify.pg.query(userQuery, [userId]);
      
      if (userRows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Utente non trovato'
        });
      }

      let currentRoles = userRows[0].dbrole || [];
      
      // Rimuovi il ruolo esistente per questo database se presente
      currentRoles = currentRoles.filter(r => r.db !== db_key);
      
      // Aggiungi il nuovo ruolo
      currentRoles.push({ db: db_key, role });

      const updateQuery = `
        UPDATE users 
        SET dbrole = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, email, firstName, lastName, dbrole
      `;
      
      const { rows } = await fastify.pg.query(updateQuery, [JSON.stringify(currentRoles), userId]);
      
      reply.send({
        success: true,
        message: 'Ruolo aggiunto con successo',
        user: rows[0]
      });
    } catch (error) {
      console.error('Errore nell\'aggiunta del ruolo:', error);
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nell\'aggiunta del ruolo' 
      });
    }
  });

  // Rimuovi un ruolo di un utente per un database specifico - richiede autenticazione e ruolo admin
  fastify.delete('/user-roles/:userId/remove/:dbKey', { preHandler: fastify.authenticate }, async (request, reply) => {
    try {
      const { userId, dbKey } = request.params;
      
      // Ottieni i ruoli attuali dell'utente
      const userQuery = 'SELECT dbrole FROM users WHERE id = $1';
      const { rows: userRows } = await fastify.pg.query(userQuery, [userId]);
      
      if (userRows.length === 0) {
        return reply.code(404).send({
          success: false,
          message: 'Utente non trovato'
        });
      }

      let currentRoles = userRows[0].dbrole || [];
      
      // Rimuovi il ruolo per questo database
      const originalLength = currentRoles.length;
      currentRoles = currentRoles.filter(r => r.db !== dbKey);
      
      if (currentRoles.length === originalLength) {
        return reply.code(404).send({
          success: false,
          message: 'Ruolo non trovato per questo database'
        });
      }

      const updateQuery = `
        UPDATE users 
        SET dbrole = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, email, firstName, lastName, dbrole
      `;
      
      const { rows } = await fastify.pg.query(updateQuery, [JSON.stringify(currentRoles), userId]);
      
      reply.send({
        success: true,
        message: 'Ruolo rimosso con successo',
        user: rows[0]
      });
    } catch (error) {
      console.error('Errore nella rimozione del ruolo:', error);
      reply.code(500).send({ 
        success: false, 
        message: 'Errore nella rimozione del ruolo' 
      });
    }
  });
}
export default auth;