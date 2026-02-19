/**
 * Singleton pg-boss
 *
 * Garantisce che esista una sola istanza di PgBoss per tutto il processo.
 * Evita race conditions e overhead di start/stop ad ogni richiesta.
 *
 * Utilizzo:
 *   import { getBoss, shutdownBoss } from './boss.singleton.js'
 *   const boss = await getBoss(process.env.POSTGRES_URL)
 */

import PgBoss from 'pg-boss';

let bossInstance = null;
let initPromise = null;

/**
 * Restituisce l'istanza singleton di PgBoss.
 * La prima chiamata crea e avvia l'istanza; le successive
 * restituiscono sempre la stessa istanza già avviata.
 *
 * @param {string} connectionString - PostgreSQL connection string
 * @returns {Promise<PgBoss>}
 */
export async function getBoss(connectionString) {
  if (bossInstance) return bossInstance;

  // Evita race condition se getBoss viene chiamata concorrentemente
  // prima che l'istanza sia pronta
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const boss = new PgBoss({
      connectionString,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInMinutes: 60,
      deleteAfterDays: 7,
    });

    boss.on('error', (err) => {
      console.error('[pg-boss] Errore non gestito:', err);
    });

    await boss.start();
    bossInstance = boss;
    console.log('[pg-boss] Singleton avviato');
    return bossInstance;
  })();

  return initPromise;
}

/**
 * Ferma l'istanza singleton di PgBoss.
 * Da chiamare nel lifecycle hook onClose di Fastify.
 */
export async function shutdownBoss() {
  if (bossInstance) {
    try {
      await bossInstance.stop();
      console.log('[pg-boss] Singleton fermato');
    } catch (err) {
      console.error('[pg-boss] Errore durante lo stop:', err.message);
    } finally {
      bossInstance = null;
      initPromise = null;
    }
  }
}
