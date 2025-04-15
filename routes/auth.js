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

  /*
  fastify.get('/newRole', async (request, reply) => {
    // http://localhost:9000/v1/auth/newRole?email=f.olivieri@inowa.it&role=admin&db=guido_cantini
    const data = request.query

    const user = await User.findOne({ email: data.email })

    if (!user) {
      return reply.code(400).send({ message: 'Utente non trovato', status: 400 });
    }

    let role = await Role.findOne({ db: data.db, 'roleAccess.user': user._id });

    if (role) {
      // Update the existing role
      role.roleAccess = role.roleAccess.map(access =>
        access.user.equals(user._id) ? { user: user._id, role: data.role } : access
      );
    } else {
      // Check if a role associated with the db exists
      role = await Role.findOne({ db: data.db });

      if (role) {
        // Add the user and role to the existing role's roleAccess array
        role.roleAccess.push({ user: user._id, role: data.role });
      } else {
        // Create a new role
        role = new Role({ db: data.db, roleAccess: [{ user: user._id, role: data.role }] });
      }
    }

    await role.save(); // Ensure the role is saved *!/
    reply.send(role);
  }) */
}
export default auth;