// backend/jobs/scadenziarioAlerts.js
import nodemailer from 'nodemailer';

export async function sendScadenziarioAlerts(fastify) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const client = await fastify.pg.pool.connect();
  try {
    // Trova tutte le scadenze in avviso raggruppate per owner
    const result = await client.query(`
      SELECT s.*, o.email as owner_email, o.name as owner_name
      FROM scadenziario s
      JOIN owners o ON s.owner_id = o.id
      WHERE s.status != 'completed'
        AND s.date - CURRENT_DATE <= s.alert_days
        AND s.date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY o.id, s.date ASC
    `);

    if (result.rows.length === 0) return;

    // Raggruppa per owner
    const byOwner = {};
    for (const row of result.rows) {
      if (!byOwner[row.owner_email]) {
        byOwner[row.owner_email] = { name: row.owner_name, scadenze: [] };
      }
      byOwner[row.owner_email].scadenze.push(row);
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    for (const [email, { name, scadenze }] of Object.entries(byOwner)) {
      const rows = scadenze.map(s =>
        `<tr>
          <td>${s.subject}</td>
          <td>${s.company_name || '-'}</td>
          <td>${s.invoice_number || '-'}</td>
          <td>${s.date}</td>
          <td>€ ${parseFloat(s.amount).toLocaleString('it-IT')}</td>
          <td>${s.status === 'overdue' ? '🔴 Scaduto' : '🟡 In scadenza'}</td>
        </tr>`
      ).join('');

      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'noreply@studiocantini.it',
        to: email,
        subject: `[Studio Cantini] ${scadenze.length} scadenze da gestire`,
        html: `
          <h2>Scadenze in arrivo — ${name}</h2>
          <table border="1" cellpadding="6" style="border-collapse:collapse">
            <thead><tr><th>Soggetto</th><th>Fornitore</th><th>N. Fattura</th><th>Scadenza</th><th>Importo</th><th>Stato</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        `,
      });
    }
  } finally {
    client.release();
  }
}
