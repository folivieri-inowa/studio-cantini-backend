# Backfill Classification Feedback per Produzione

## 🎯 Problema

Lo strumento di **Analytics Classificazione AI** mostra dati incompleti perché legge dalla tabella `classification_feedback`, che contiene solo **257 record** invece dei **7.410 record** totali classificati.

### Perché succede?

La tabella `classification_feedback` viene popolata solo quando si usa il sistema di classificazione automatica. Le transazioni classificate manualmente o importate già classificate non hanno un record corrispondente in `classification_feedback`.

**Risultato**: L'analytics mostra solo il 3,4% dei dati (257/7410).

## ✅ Soluzione

Eseguire il **backfill** per popolare `classification_feedback` con tutte le transazioni già classificate.

## 🚀 Come Eseguire in Produzione

### Opzione 1: Script Automatico (Raccomandato)

```bash
cd backend/migrations
./backfill-production.sh
```

Lo script ti guiderà nella scelta del metodo di connessione:
- **Kubernetes** (se il database è in un cluster K8s)
- **psql** (connessione diretta)
- **Docker** (se il database è in un container)

### Opzione 2: Kubernetes (Manuale)

Se il database PostgreSQL è nel cluster Kubernetes:

```bash
# 1. Verifica che il pod esista
kubectl get pods -n studio-cantini | grep postgresql

# 2. Esegui il backfill
cat backend/migrations/backfill-production.sql | \
  kubectl exec -i -n studio-cantini postgresql-0 -- \
  psql -U postgres -d studio-cantini

# 3. Verifica i risultati
kubectl exec -n studio-cantini postgresql-0 -- \
  psql -U postgres -d studio-cantini \
  -c "SELECT COUNT(*) as total FROM classification_feedback;"
```

### Opzione 3: psql Diretto

Se hai accesso diretto al database:

```bash
# Con POSTGRES_URL
psql $POSTGRES_URL -f backend/migrations/backfill-production.sql

# Oppure con parametri espliciti
psql -h postgres.host -p 5432 -U postgres -d studio-cantini \
  -f backend/migrations/backfill-production.sql
```

### Opzione 4: Docker

Se il database è in un container Docker:

```bash
cat backend/migrations/backfill-production.sql | \
  docker exec -i postgres-container \
  psql -U postgres -d studio-cantini
```

## 📊 Cosa Fa lo Script

1. **Controlla lo stato attuale**: mostra quanti record sono già presenti
2. **Inserisce i dati storici**: tutte le transazioni classificate che non sono già in `classification_feedback`
3. **Verifica l'integrità**: controlla che non ci siano duplicati
4. **Mostra statistiche**: distribuzione per database e metodo di classificazione

### Dati Inseriti

Per ogni transazione storica viene creato un record con:
- `suggestion_method`: `'historical'` (per distinguerli dai nuovi)
- `suggestion_confidence`: `100` (erano già classificati correttamente)
- `suggested_*`: uguale a `corrected_*` (non sappiamo cosa era stato suggerito originariamente)
- `created_by`: `'migration_backfill'`

## 🔍 Verifica Post-Backfill

Dopo l'esecuzione, verifica che tutto sia ok:

```sql
-- Totale record
SELECT COUNT(*) as total_feedback FROM classification_feedback;
-- Dovrebbe essere ~7410

-- Distribuzione per database
SELECT db, COUNT(*) as count 
FROM classification_feedback 
GROUP BY db;

-- Distribuzione per metodo
SELECT suggestion_method, COUNT(*) as count 
FROM classification_feedback 
GROUP BY suggestion_method;

-- Verifica copertura
SELECT 
  (SELECT COUNT(*) FROM transactions WHERE categoryid IS NOT NULL) as classified_transactions,
  (SELECT COUNT(DISTINCT transaction_id) FROM classification_feedback) as feedback_records,
  ROUND(
    (SELECT COUNT(DISTINCT transaction_id) FROM classification_feedback)::numeric / 
    NULLIF((SELECT COUNT(*) FROM transactions WHERE categoryid IS NOT NULL), 0) * 100, 
    2
  ) as coverage_percentage;
```

## 📈 Risultato Atteso

Dopo il backfill, l'**Analytics Classificazione AI** mostrerà:
- ✅ ~7.410 classificazioni totali (invece di 257)
- ✅ Top 10 categorie e soggetti accurati
- ✅ Trend di confidence nel tempo
- ✅ Distribuzione per metodo di classificazione
- ✅ Statistiche complete per db1 e db2

## 🔄 Quando Eseguirlo

- **Una volta**: Dopo l'installazione del nuovo sistema di analytics
- **Non necessario ripeterlo**: Le nuove classificazioni vengono già registrate automaticamente in `classification_feedback`
- **Safe to re-run**: Lo script salta automaticamente i record già presenti (no duplicati)

## 🛡️ Sicurezza

- Lo script usa una **transazione** (BEGIN/COMMIT) per garantire atomicità
- Controlla automaticamente l'esistenza dei record per evitare duplicati
- Non modifica né cancella dati esistenti
- Opera solo in **INSERT** (non UPDATE né DELETE)

## 📝 Rollback

Se necessario, puoi rimuovere solo i record del backfill:

```sql
DELETE FROM classification_feedback 
WHERE created_by = 'migration_backfill';
```

## 🎯 Accesso all'Analytics

Dopo il backfill, vai su:

**Dashboard → Machine Learning → Analytics**

Vedrai i dati completi di tutte le 7.410 transazioni classificate!
